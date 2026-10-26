/**
 * 擷取到 Page 之後：本機流水線（offscreen）→ Translator（有的話）→ side panel 逐字稿（spec #27 第 3 節）。
 * 沒有 Translator（沒有 API key）時只顯示 OCR 原文＋kuromoji 讀音、標「未翻譯」（spec 第 5 節）；
 * 翻譯失敗時也退回 kuromoji 讀音，並帶上錯誤訊息。設定 key 之後按「翻譯此頁」用同一份辨識結果重新翻譯。
 * 翻譯快取（#33）：先查 (Series ID, Page hash)，命中就直接用、不跑本機流水線也不呼叫 Translator；翻譯成功才寫入。
 *
 * 翻譯佇列（#34、spec 第 3.4 節；排程在 translation-queue.ts）：
 * - 兩段：本機段（偵測／OCR）併發 1、LLM 段併發 2，跨 tab 共用（offscreen 只有一份模型）。
 * - 後進先出：新出現的可見 Page 先做；同一次擷取裡依閱讀順序。工作帶 priority（v1 只有可見頁）。
 * - 翻太快：已不在畫面上、還沒開始的工作丟掉（之後再出現會重新排）；已開始的做完、寫進快取，但不顯示也不覆蓋。
 * - 去重：同一個 Page（hash 在門檻內）已有工作在跑就不重複排，等那份結果。
 * - 自動翻譯關著時新 Page 停在 pending，按「翻譯此頁」才排。快取命中照樣直接顯示（不算翻譯）。
 * - 429 依 retry-after 退避重試在 Translator 裡（claude-translator.ts）；重試後仍失敗就帶 translateError，按「重試」重送 LLM。
 *
 * Series Notes（#37；順序在 notes-ledger.ts）：送出 LLM 時帶這個 Series 的 Notes 快照，回來後依送出順序套用
 * notes_changes，再寫快取。沒有 Series 時不帶 Notes 也不套用。
 */
import type { AnalyzeRequest, CropRequest, PageThumb, PageView } from '../shared/messages.ts';
import { findSamePage } from '../shared/page-hash.ts';
import type { PageText, PageTranslation } from '../shared/page-text.ts';
import { usedNotes } from '../shared/series-notes.ts';
import { createTrace } from '../shared/trace.ts';
import type { NotesEntry, TranslateInput, TranslateOutput, Translator } from '../shared/translator.ts';
import { createNotesLedger, type NotesLedger, type NotesStore } from './notes-ledger.ts';
import { createTranslationQueue, type QueuedJob } from './translation-queue.ts';

export type { NotesStore };

export interface PageCache {
  /** 同一個 Series 裡 hash 在門檻內最接近的一筆。 */
  find(seriesId: string, pageHash: string): Promise<PageTranslation | undefined>;
  save(translation: PageTranslation): Promise<void>;
}

/** 給 e2e 量排程用：enqueue＝排進本機段、start＝本機段開始、drop＝沒開始就丟掉、llm＝送出 LLM、done＝做完（含 LLM）。 */
export type JobEventKind = 'enqueue' | 'start' | 'drop' | 'llm' | 'done';

export interface JobEvent {
  tabId: number;
  event: JobEventKind;
  pageHash: string;
}

export interface TranscriberDeps {
  analyze(request: AnalyzeRequest): Promise<PageText>;
  /** 沒有 API key 時回傳 undefined。 */
  getTranslator(): Translator | undefined | Promise<Translator | undefined>;
  /** 這個 tab 啟動時選定的 Series（或 Provisional Series）；沒有就不查也不寫快取。 */
  getSeriesId(tabId: number): Promise<string | undefined>;
  cache: PageCache;
  notes: NotesStore;
  publish(tabId: number, pages: PageView[]): void;
  onJobEvent?(event: JobEvent): void;
}

type Transcript = PageView['transcript'];

// TODO(#38)：Translator 的 prompt 版本（offscreen/claude-translator.ts 的 PROMPT_VERSION）還沒傳到 SW；過時提示要比對它
const PROMPT_VERSION = '';

const trace = createTrace('sw');

/** 工作的 priority：可見頁 > 預翻頁（v1 只有可見頁，spec 第 10 節）。 */
export const PRIORITY_VISIBLE = 1;

function toTranslateInput(text: PageText, seriesNotes: NotesEntry[]): TranslateInput {
  const items = [
    ...text.balloons.map((b) => ({ order: b.order, item: { id: b.id, kind: 'balloon' as const, 原文: b.原文, orientation: b.orientation } })),
    ...text.looseText.map((l) => ({ order: l.order, item: { id: l.id, kind: 'loose' as const, 原文: l.原文, orientation: l.orientation } })),
  ];
  return { seriesNotes, items: items.sort((a, b) => a.order - b.order).map((i) => i.item) };
}

function applyTranslation(text: PageText, output: TranslateOutput): PageText {
  const byId = new Map(output.items.map((item) => [item.id, item]));
  const merge = <T extends { id: string; 讀音: string; 讀音來源: 'llm' | 'kuromoji'; 譯文: string; unreadable: boolean }>(entry: T): T => {
    const item = byId.get(entry.id);
    return item ? { ...entry, 讀音: item.讀音, 讀音來源: 'llm', 譯文: item.譯文, unreadable: item.unreadable } : entry;
  };
  return { balloons: text.balloons.map(merge), looseText: text.looseText.map(merge) };
}

/** 翻譯成功後寫進快取的位置；沒有 Series 時不寫。 */
interface CacheTarget {
  seriesId: string | undefined;
  pageHash: string;
}

/** text 是本機流水線的結果（kuromoji 讀音）；失敗時就顯示它。只有翻譯成功才寫快取。 */
async function translateText(
  text: PageText,
  translator: Translator | undefined,
  { cache, ledger }: { cache: PageCache; ledger: NotesLedger },
  target: CacheTarget,
): Promise<Transcript> {
  if (!translator) return { state: 'done', text, translated: false };
  // 送出的這一刻拿號碼牌：notes_changes 依送出順序套用
  const turn = target.seriesId === undefined ? undefined : ledger.checkout(target.seriesId);
  const seriesNotes = (await turn?.notes) ?? [];
  let output: TranslateOutput;
  const startedAt = Date.now();
  try {
    output = await translator.translatePage(toTranslateInput(text, seriesNotes));
    trace('translate:done', { pageHash: target.pageHash, ms: Date.now() - startedAt, model: output.model, usage: output.usage });
  } catch (e) {
    // 429／5xx 的重試在 Translator 裡（claude-translator.ts）；這裡是重試後仍失敗
    console.warn('translate failed', e);
    trace('translate:error', { pageHash: target.pageHash, ms: Date.now() - startedAt, error: e });
    turn?.release();
    return { state: 'done', text, translated: false, translateError: e instanceof Error ? e.message : String(e) };
  }
  const translated = applyTranslation(text, output);
  const { model, latencyMs, usage } = output;
  // 套用後的條目：這頁剛新增或補上譯文的也算這頁用到的
  const notes = turn
    ? await turn.commit(output.notes_changes, { pageHash: target.pageHash, balloonTexts: text.balloons.map((b) => b.原文) })
    : seriesNotes;
  if (target.seriesId !== undefined) {
    const entry: PageTranslation = {
      ...translated,
      seriesId: target.seriesId,
      pageHash: target.pageHash,
      usedNotes: usedNotes(notes, [...text.balloons, ...text.looseText].map((t) => t.原文)),
      model,
      promptVersion: PROMPT_VERSION,
      usage,
      latencyMs,
      translatedAt: Date.now(),
    };
    // 寫不進去只是下次要重翻，這次的結果照樣顯示。
    await cache.save(entry).catch((e: unknown) => console.warn('cache save failed', e));
  }
  return { state: 'done', text: translated, translated: true, translation: { source: 'translated', model, latencyMs, usage } };
}

/** 一個 tab 這次啟動看過的一個 Page（以 hash 認）。 */
interface PageRecord {
  pageHash: string;
  seriesId: string | undefined;
  /** 第一次看到它時的截圖與候選；本機流水線從這張截圖裁 Page。 */
  request: AnalyzeRequest;
  transcript: Transcript;
  /** 本機流水線的結果，「翻譯此頁／重試」用它重新翻譯，不必重跑 OCR。命中快取時沒有。 */
  text?: PageText;
  /** 有工作在排或在跑。 */
  job?: Job;
  /** 目前的工作做完（或被丟掉）時 resolve。 */
  settled: Promise<void>;
}

interface TabState {
  tabId: number;
  /** 最近一次擷取到的可見 Page（依閱讀順序）。 */
  pages: PageThumb[];
  records: PageRecord[];
}

interface Job extends QueuedJob {
  tab: TabState;
  record: PageRecord;
  /** 進到 LLM 段才有。 */
  translator?: Translator;
  resolve(): void;
}

export function createTranscriber(deps: TranscriberDeps) {
  const ledger = createNotesLedger(deps.notes);
  const tabs = new Map<number, TabState>();
  const views = new Map<number, PageView[]>();
  const autoTranslate = new Map<number, boolean>();
  let batches = 0;

  const isCurrent = (tab: TabState) => tabs.get(tab.tabId) === tab;
  const isVisible = (tab: TabState, record: PageRecord) => isCurrent(tab) && findSamePage(tab.pages, record.pageHash) !== undefined;
  const report = (job: Job, event: JobEventKind) => deps.onJobEvent?.({ tabId: job.tab.tabId, event, pageHash: job.record.pageHash });

  const queue = createTranslationQueue<Job>({
    runLocal,
    runLlm,
    isWanted: (job) => isVisible(job.tab, job.record),
    onDrop(job) {
      job.tab.records = job.tab.records.filter((r) => r !== job.record);
      report(job, 'drop');
      finish(job, undefined);
    },
  });

  function publish(tab: TabState): void {
    if (!isCurrent(tab)) return;
    const current = tab.pages.map((page): PageView => ({
      ...page,
      transcript: findSamePage(tab.records, page.pageHash)?.transcript ?? { state: 'analyzing' },
    }));
    views.set(tab.tabId, current);
    deps.publish(tab.tabId, current);
  }

  function newJob(tab: TabState, record: PageRecord, batch: number, index: number): Job {
    let resolve!: () => void;
    record.settled = new Promise<void>((r) => (resolve = r));
    const job: Job = { tab, record, priority: PRIORITY_VISIBLE, batch, index, resolve };
    record.job = job;
    return job;
  }

  /** 工作結束；transcript undefined＝沒做就放掉（已停止、被丟掉，或還沒排就翻走）。 */
  function finish(job: Job, transcript: Transcript | undefined): void {
    const { tab, record } = job;
    if (transcript) record.transcript = transcript;
    record.job = undefined;
    job.resolve();
    prune(tab);
    publish(tab);
  }

  /** 工作跑完（本機段失敗、沒有 Translator，或 LLM 段做完）：回報 done 並更新這頁。 */
  function complete(job: Job, transcript: Transcript): void {
    report(job, 'done');
    finish(job, transcript);
  }

  /**
   * 記憶體裡只留畫面上的 Page 與還在跑的工作；翻走的 Page 之後再出現時從快取拿（「快取」狀態），
   * 沒翻譯的（沒有 key）就重跑本機流水線。
   */
  function prune(tab: TabState): void {
    tab.records = tab.records.filter((r) => r.job !== undefined || isVisible(tab, r));
  }

  /** 本機流水線失敗的 Page 不留：下次擷取（例如修好模型後按重試）重跑。 */
  function forgetErrors(tab: TabState): void {
    tab.records = tab.records.filter((r) => r.job !== undefined || r.transcript.state !== 'error');
  }

  function enqueueLocal(job: Job): void {
    report(job, 'enqueue');
    queue.enqueueLocal(job);
  }

  /** 本機段；回傳 true＝接著排進 LLM 段。 */
  async function runLocal(job: Job): Promise<boolean> {
    const { record } = job;
    report(job, 'start');
    let text: PageText;
    const startedAt = Date.now();
    try {
      text = await deps.analyze(record.request);
      trace('analyze:done', { pageHash: record.pageHash, anchorId: record.request.candidate.anchorId, ms: Date.now() - startedAt, balloons: text.balloons.length, looseText: text.looseText.length });
    } catch (e) {
      trace('analyze:error', { pageHash: record.pageHash, ms: Date.now() - startedAt, error: e });
      complete(job, { state: 'error', message: e instanceof Error ? e.message : String(e) });
      return false;
    }
    record.text = text;
    const translator = await deps.getTranslator();
    if (!translator) {
      complete(job, { state: 'done', text, translated: false });
      return false;
    }
    job.translator = translator;
    return true;
  }

  async function runLlm(job: Job): Promise<void> {
    const { record } = job;
    report(job, 'llm');
    complete(job, await translateText(record.text!, job.translator, { cache: deps.cache, ledger }, { seriesId: record.seriesId, pageHash: record.pageHash }));
  }

  async function lookupCache(seriesId: string | undefined, pageHash: string): Promise<Transcript | undefined> {
    if (seriesId === undefined) {
      trace('cache:noSeries', { pageHash });
      return undefined;
    }
    const cached = await deps.cache.find(seriesId, pageHash).catch((e: unknown) => {
      console.warn('cache lookup failed', e);
      return undefined;
    });
    trace(cached ? 'cache:hit' : 'cache:miss', { seriesId, pageHash, cachedHash: cached?.pageHash });
    if (!cached) return undefined;
    const { balloons, looseText, model, latencyMs, usage } = cached;
    // 命中快取時沒有本機流水線的結果（text），「翻譯此頁／重新翻譯」不會重翻這頁。
    return { state: 'done', text: { balloons, looseText }, translated: true, translation: { source: 'cache', model, latencyMs, usage } };
  }

  /**
   * 新的擷取：可見的 Page 換成這一批。新 Page 先查快取，沒命中就排進佇列（自動翻譯關著時停在 pending）。
   * 回傳的 promise 在這一批可見 Page 的工作都做完（或被丟掉）時 resolve。
   */
  async function update(tabId: number, pages: PageThumb[], capture: CropRequest | undefined): Promise<void> {
    // 沒有截圖＝畫面上沒有完整可見的 Page
    if (!capture) pages = [];
    let tab = tabs.get(tabId);
    if (!tab) {
      tab = { tabId, pages: [], records: [] };
      tabs.set(tabId, tab);
    }
    tab.pages = pages;
    prune(tab);
    forgetErrors(tab);
    const batch = ++batches;
    /** 這次擷取畫面上的 Page（已認得的＋新的）；等它們的工作都結束才 resolve。 */
    const visibleRecords = new Set<PageRecord>();
    /** 第一次出現的 Page，要查快取或排進佇列。 */
    const newPages: { record: PageRecord; index: number }[] = [];
    for (const [index, page] of pages.entries()) {
      const existing = findSamePage(tab.records, page.pageHash);
      if (existing) {
        visibleRecords.add(existing);
        continue;
      }
      const record: PageRecord = {
        pageHash: page.pageHash,
        seriesId: undefined,
        request: {
          screenshot: capture!.screenshot,
          viewport: capture!.viewport,
          candidate: { anchorId: page.anchorId, rect: page.rect },
          ...(page.sub ? { sub: page.sub } : {}),
        },
        transcript: { state: 'analyzing' },
        settled: Promise.resolve(),
      };
      tab.records.push(record);
      visibleRecords.add(record);
      newPages.push({ record, index });
    }
    queue.dropUnwanted();
    publish(tab);

    const seriesId = await deps.getSeriesId(tabId);
    // 查快取期間佔住這頁，同一頁又出現時不會重複排
    const jobs = newPages.map(({ record, index }) => {
      record.seriesId = seriesId;
      return newJob(tab, record, batch, index);
    });
    const lookups = await Promise.all(jobs.map((job) => lookupCache(seriesId, job.record.pageHash)));
    // 快取都查完才依閱讀順序排：佇列一有工作就開始跑，Spread 的左頁先查完也不能比右頁先送出 LLM（spec 第 3.4 節）
    for (const [i, job] of jobs.entries()) {
      const { record } = job;
      const cached = lookups[i];
      if (!isCurrent(tab)) finish(job, undefined);
      else if (cached) finish(job, cached);
      else if (!isVisible(tab, record)) {
        tab.records = tab.records.filter((r) => r !== record);
        finish(job, undefined);
      } else if (autoTranslate.get(tabId) === false) finish(job, { state: 'pending' });
      else enqueueLocal(job);
    }
    await Promise.all([...visibleRecords].map((r) => r.settled));
  }

  /**
   * 「翻譯此頁／重新翻譯／重試」：可見的 Page 裡，pending 的排進佇列；已辨識完的重新翻譯（不重跑 OCR）。
   * 已有工作在跑的不重複排。沒有 key 時只會跑 pending 的本機流水線。
   */
  async function translate(tabId: number): Promise<void> {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const translator = await deps.getTranslator();
    const visible = [...new Set(tab.pages.flatMap((p) => findSamePage(tab.records, p.pageHash) ?? []))];
    const batch = ++batches;
    const started: PageRecord[] = [];
    for (const [index, record] of visible.entries()) {
      if (record.job) continue;
      if (record.transcript.state === 'pending') {
        record.transcript = { state: 'analyzing' };
        enqueueLocal(newJob(tab, record, batch, index));
      } else if (translator && record.transcript.state === 'done' && record.text) {
        record.transcript = { ...record.transcript, translating: true };
        const job = newJob(tab, record, batch, index);
        job.translator = translator;
        queue.enqueueLlm(job);
      } else continue;
      started.push(record);
    }
    if (started.length === 0) return;
    publish(tab);
    await Promise.all(started.map((r) => r.settled));
  }

  /** side panel 的「自動翻譯」開關（每個 tab；預設開，停止後回到預設）。打開時把 pending 的 Page 排進佇列。 */
  function setAutoTranslate(tabId: number, enabled: boolean): Promise<void> {
    autoTranslate.set(tabId, enabled);
    return enabled ? translatePending(tabId) : Promise.resolve();
  }

  async function translatePending(tabId: number): Promise<void> {
    const tab = tabs.get(tabId);
    if (!tab || !tab.records.some((r) => r.transcript.state === 'pending')) return;
    await translate(tabId);
  }

  function isAutoTranslate(tabId: number): boolean {
    return autoTranslate.get(tabId) ?? true;
  }

  function get(tabId: number): PageView[] {
    return views.get(tabId) ?? [];
  }

  /**
   * 同 origin 重新整理（content script 重新注入，anchor 都換了）：忘掉畫面上的 Page，下次擷取重新查快取。
   * 還沒開始的工作丟掉，已開始的做完只寫快取。設定（自動翻譯）保留。
   */
  function resetPages(tabId: number): void {
    tabs.delete(tabId);
    views.delete(tabId);
    queue.dropUnwanted();
    deps.publish(tabId, []);
  }

  /**
   * 這個 tab 的 Series 換了 ID 但畫面上的 Page 不必重做（#36 合併：快取已改到目標 ID）：
   * 已記住的 Page 之後「翻譯此頁／重試」寫進新的 ID。
   */
  function reassignSeries(tabId: number, seriesId: string): void {
    for (const record of tabs.get(tabId)?.records ?? []) record.seriesId = seriesId;
  }

  /** 停止或關 tab：同 resetPages，設定也回到預設。 */
  function clear(tabId: number): void {
    autoTranslate.delete(tabId);
    resetPages(tabId);
  }

  return { update, translate, setAutoTranslate, isAutoTranslate, get, resetPages, reassignSeries, clear };
}
