/**
 * Translator 的 Claude 實作（spec #27 第 5 節、#15）：offscreen document 直接 fetch Messages API，
 * 帶 anthropic-dangerous-direct-browser-access，不宣告 api.anthropic.com 的 host_permissions。
 * Haiku 5.5 文字模式、effort low、structured outputs。每個 Page 兩次呼叫（ADR 0005）：
 * ① translatePage 關 thinking、只回譯文，user message 先放 Prior Pages 再放這頁的原文；
 * ② proposeNotes 開 thinking、只回 notes_changes，輸入這頁的原文與 ① 的譯文。
 * 兩次都把 Series Notes 放在標了 cache_control 的 system（固定前綴）。
 *
 * API key 只在 offscreen document 裡用（ADR 0001）；錯誤訊息只帶 API 回的訊息，不帶 key。
 */
import type {
  CallInfo,
  NotesChanges,
  NotesEntry,
  NotesInput,
  NotesOutput,
  TranslatedLine,
  TranslateInput,
  TranslateOutput,
  Translator,
} from '../shared/translator.ts';

export const CLAUDE_MODEL = 'claude-haiku-5-5';
/** 寫進快取判斷過時用（#33）；改 prompt 或 schema 就要改這個。 */
export const PROMPT_VERSION = 'claude-text-v3';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
/** spec 第 3.4 節：429 最多重試 3 次。529／5xx 同樣處理。 */
const MAX_RETRIES = 3;
const MAX_TOKENS = 16_000;

/** list price，$/MTok（claude-api skill 2026-10-06 的價目表）。cache write 是 5 分 TTL 的 input × 1.25。 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/** Messages API 回應的 usage。 */
export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** 費用＝usage × 價目表。不認得的模型回傳 NaN，不猜。 */
export function costUsd(model: string, usage: ApiUsage): number {
  const price = PRICES[model];
  if (!price) return NaN;
  const total =
    usage.input_tokens * price.input +
    (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
    usage.output_tokens * price.output;
  return total / 1e6;
}

export interface ClaudeDeps {
  apiKey: string;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** 重試前等待；signal 中止時應該 reject。 */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
}

const TRANSLATE_TEXT = `你是日文漫畫翻譯助手，幫助讀者一邊看漫畫一邊學日文。

使用者會給你一張漫畫 Page 上、已經用 OCR 讀出來並依閱讀順序排好的日文文字（JSON 陣列）。每一項有：
- id：這段文字的代號，回答時原樣帶回，不要改、不要漏、不要自己新增。
- kind：balloon 是對話框裡的台詞；loose 是對話框外的文字（旁白、狀聲詞、招牌、手寫字等）。
- ja：OCR 讀到的原文。OCR 偶爾會有錯字、漏字或多出符號，請依上下文推測原本的意思。

請對每一項回傳：
- reading：整句的假名讀音，漢字一律寫成平假名；原文的片假名維持片假名，標點照原文。
- zh：自然、口語的台灣繁體中文譯文，符合角色的語氣；狀聲詞翻成中文讀者習慣的狀聲詞。
- unreadable：如果 ja 明顯是 OCR 亂碼（例如設計字體被讀成一串不成句的字），沒辦法判斷原本寫什麼，就設為 true，reading 與 zh 留空字串。不要硬翻亂碼。

閱讀順序已經由程式決定，請照輸入的順序回答，不要重排。

翻譯時請遵守 Series Notes 的譯名。

使用者可能先給你前面幾頁的原文與譯文（context），讓你知道前後劇情、誰在說話、語氣與已經用過的譯名。context 只用來理解，不要翻譯、也不要回傳；譯名與語氣請跟 context 保持一致。

只輸出符合 schema 的 JSON。`;

const NOTES_TEXT = `你是日文漫畫翻譯助手的 Series Notes 整理員。Series Notes 用來讓之後的 Page 譯名一致。

使用者會給你一張漫畫 Page 上、依閱讀順序排好的文字（JSON 陣列），每一項有：
- kind：balloon 是對話框裡的台詞；loose 是對話框外的文字（旁白、狀聲詞、招牌、手寫字等）。
- ja：OCR 讀到的日文原文，偶爾有錯字。
- zh：這一頁已經顯示給讀者的繁體中文譯文。

請整理這部作品的 Series Notes 變更（notes_changes）：
- added：這頁出現、但 Series Notes 裡還沒有的人名、地名、專有名詞或固定用語。ja 是原文，reading 是讀音，zh 必須是這頁譯文（zh）裡實際用的譯名，不要另取新譯名，category 例如「人名」「地名」「用語」；不知道的欄位填空字串。ja 要原樣出現在某個 balloon 的原文裡；只出現在 loose 的、或看起來是 OCR 誤讀的不要加。
- filled：Series Notes 已有的條目，如果某個欄位是空的、而這頁讓你知道了答案，就補上；其他欄位填空字串。
- suggestions：如果你認為 Series Notes 裡既有的譯名不對，不要直接改，提出建議譯名 zh 與理由 reason。
- 沒有變更就回傳空陣列。不要記劇情進展。

只輸出符合 schema 的 JSON。`;

const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = (description?: string) => (description ? { type: 'string', description } : { type: 'string' });

/**
 * structured outputs 不支援任意物件，Notes 欄位全部列出、全部 required，空字串代表沒有。
 * 沒有自稱、語氣、稱呼：只由人填（ADR 0005）。
 */
const NOTES_FIELDS = {
  ja: str('原文'),
  reading: str('讀音'),
  zh: str('譯文'),
  category: str('類別，例如 人名、地名、用語'),
  note: str('備註'),
};

const TRANSLATE_SCHEMA = obj({
  items: {
    type: 'array',
    items: obj({
      id: str(),
      reading: str('整句假名讀音'),
      zh: str('繁體中文（台灣）譯文'),
      unreadable: { type: 'boolean', description: '原文是無法判斷的 OCR 亂碼' },
    }),
  },
});

const NOTES_SCHEMA = obj({
  notes_changes: obj({
    added: { type: 'array', items: obj(NOTES_FIELDS) },
    filled: { type: 'array', items: obj(NOTES_FIELDS) },
    suggestions: { type: 'array', items: obj({ ja: str('既有條目的原文'), zh: str('建議譯文'), reason: str('理由') }) },
  }),
});

const CACHED = { cache_control: { type: 'ephemeral' } } as const;

/**
 * system 分兩段、各標 cache_control：固定的指示在前，Series Notes 在後。前一頁新增了條目時 Notes 那段會變，
 * 指示那段仍逐字相同，第 2 頁起照樣吃得到快取（#37）。Notes 原樣依傳入的順序序列化。
 */
function systemBlocks(instructions: string, notesIntro: string, notes: NotesEntry[]) {
  const blocks = [{ type: 'text', text: instructions, ...CACHED }];
  if (notes.length === 0) return blocks;
  const entries = notes.map(({ seriesId: _seriesId, locked: _locked, ...entry }) => entry);
  return [...blocks, { type: 'text', text: `${notesIntro}\n${JSON.stringify(entries)}`, ...CACHED }];
}

const toWire = (lines: TranslatedLine[]) => lines.map(({ kind, 原文, 譯文 }) => ({ kind, ja: 原文, zh: 譯文 }));

const HEADERS = (apiKey: string) => ({
  'content-type': 'application/json',
  'x-api-key': apiKey,
  'anthropic-version': API_VERSION,
  'anthropic-dangerous-direct-browser-access': 'true',
});

interface ApiResponse {
  model: string;
  stop_reason: string | null;
  content: { type: string; text?: string }[];
  usage: ApiUsage;
}

type NotesFields = Record<keyof typeof NOTES_FIELDS, string>;

interface TranslateAnswer {
  items: { id: string; reading: string; zh: string; unreadable: boolean }[];
}

interface NotesAnswer {
  notes_changes: {
    added: NotesFields[];
    filled: NotesFields[];
    suggestions: { ja: string; zh: string; reason: string }[];
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNotesFields = (v: unknown): v is NotesFields =>
  typeof v === 'object' && v !== null && Object.keys(NOTES_FIELDS).every((k) => isStr((v as Record<string, unknown>)[k]));

/** structured outputs 理論上一定符合 schema；還是檢查，避免壞資料進逐字稿與 Notes。 */
function isTranslateAnswer(v: unknown): v is TranslateAnswer {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Partial<TranslateAnswer>;
  return Array.isArray(a.items) && a.items.every((i) => isStr(i?.id) && isStr(i.reading) && isStr(i.zh) && typeof i.unreadable === 'boolean');
}

function isNotesAnswer(v: unknown): v is NotesAnswer {
  if (typeof v !== 'object' || v === null) return false;
  const n = (v as Partial<NotesAnswer>).notes_changes;
  return (
    typeof n === 'object' &&
    n !== null &&
    Array.isArray(n.added) &&
    n.added.every(isNotesFields) &&
    Array.isArray(n.filled) &&
    n.filled.every(isNotesFields) &&
    Array.isArray(n.suggestions) &&
    n.suggestions.every((s) => isStr(s?.ja) && isStr(s.zh) && isStr(s.reason))
  );
}

/** schema 的英文欄位 → NotesEntry 的欄位；空字串＝沒有這個欄位。 */
function toNotesFields(f: NotesFields): Partial<NotesEntry> {
  const out: Partial<NotesEntry> = {};
  if (f.ja) out.原文 = f.ja;
  if (f.reading) out.讀音 = f.reading;
  if (f.zh) out.譯文 = f.zh;
  if (f.category) out.類別 = f.category;
  if (f.note) out.備註 = f.note;
  return out;
}

function toNotesChanges({ notes_changes: n }: NotesAnswer): NotesChanges {
  return {
    added: n.added.map((f) => ({ 讀音: '', 譯文: '', 類別: '', ...toNotesFields(f), 原文: f.ja })),
    filled: n.filled.map(({ ja, ...f }) => {
      const { 原文: _ja, ...fields } = toNotesFields({ ...f, ja: '' });
      return { 原文: ja, fields };
    }),
    suggestions: n.suggestions.map((s) => ({ 原文: s.ja, 建議譯文: s.zh, ...(s.reason ? { 理由: s.reason } : {}) })),
  };
}

export function createClaudeTranslator(deps: ClaudeDeps): Translator & { testConnection(): Promise<{ model: string }> } {
  async function post(body: unknown, signal?: AbortSignal): Promise<ApiResponse> {
    for (let attempt = 0; ; attempt++) {
      const response = await deps.fetch(API_URL, {
        method: 'POST',
        headers: HEADERS(deps.apiKey),
        body: JSON.stringify(body),
        signal,
      });
      if (response.ok) return (await response.json()) as ApiResponse;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) throw new Error(`Claude API ${response.status}：${await errorMessage(response)}`);
      const retryAfter = Number(response.headers.get('retry-after'));
      await deps.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 2000, signal);
    }
  }

  /** 送出、檢查 stop_reason 與 schema；回傳答案與這次呼叫的花費。 */
  async function call<A>(body: unknown, isValid: (v: unknown) => v is A, signal?: AbortSignal): Promise<{ answer: A } & CallInfo> {
    const started = deps.now();
    const json = await post(body, signal);
    const latencyMs = deps.now() - started;
    if (json.stop_reason !== 'end_turn') throw new Error(`Claude 沒有完成回答（stop_reason: ${json.stop_reason}）`);
    const text = json.content.find((b) => b.type === 'text')?.text;
    let answer: unknown;
    try {
      answer = JSON.parse(text ?? '');
    } catch {
      answer = undefined;
    }
    if (!isValid(answer)) throw new Error('Claude 的回應格式不符合 schema');
    const u = json.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    return {
      answer,
      usage: {
        inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + cacheRead,
        outputTokens: u.output_tokens,
        cacheReadTokens: cacheRead,
        costUsd: Math.round(costUsd(json.model, u) * 1e9) / 1e9,
      },
      model: json.model,
      latencyMs,
    };
  }

  return {
    async translatePage(input: TranslateInput, signal?: AbortSignal): Promise<TranslateOutput> {
      const current = JSON.stringify(input.items.map(({ id, kind, 原文 }) => ({ id, kind, ja: 原文 })));
      // Prior Pages 每頁都不同，放在 user message，不動 system 的 prompt cache
      const content =
        input.priorPages.length > 0
          ? [
              { type: 'text', text: `context（前面的頁，依閱讀順序）：\n${JSON.stringify(input.priorPages.map(toWire))}` },
              { type: 'text', text: `這一頁要翻譯的文字：\n${current}` },
            ]
          : [{ type: 'text', text: current }];
      const { answer, ...info } = await call(
        {
          model: CLAUDE_MODEL,
          max_tokens: MAX_TOKENS,
          system: systemBlocks(TRANSLATE_TEXT, '以下是這部作品的 Series Notes，翻譯時請遵守：', input.seriesNotes),
          messages: [{ role: 'user', content }],
          // 翻譯不需要 thinking、需要的是上下文（ADR 0005）。Haiku 5.5 在 effort ≤ high 時才能關
          thinking: { type: 'disabled' },
          output_config: { effort: 'low', format: { type: 'json_schema', schema: TRANSLATE_SCHEMA } },
        },
        isTranslateAnswer,
        signal,
      );
      return { items: answer.items.map((i) => ({ id: i.id, 讀音: i.reading, 譯文: i.zh, unreadable: i.unreadable })), ...info };
    },

    async proposeNotes(input: NotesInput, signal?: AbortSignal): Promise<NotesOutput> {
      const { answer, ...info } = await call(
        {
          model: CLAUDE_MODEL,
          max_tokens: MAX_TOKENS,
          system: systemBlocks(NOTES_TEXT, '以下是這部作品目前的 Series Notes：', input.seriesNotes),
          messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(toWire(input.items)) }] }],
          output_config: { effort: 'low', format: { type: 'json_schema', schema: NOTES_SCHEMA } },
        },
        isNotesAnswer,
        signal,
      );
      return { notes_changes: toNotesChanges(answer), ...info };
    },

    /** side panel 的「測試連線」：同一個 endpoint 與 header，送最小的 request（費用約 $0.000002）。 */
    async testConnection() {
      const json = await post({
        model: CLAUDE_MODEL,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
        output_config: { effort: 'low' },
      });
      return { model: json.model };
    },
  };
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? response.statusText;
  } catch {
    return response.statusText;
  }
}
