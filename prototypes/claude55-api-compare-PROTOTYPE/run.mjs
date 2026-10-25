// PROTOTYPE（#15）：直接呼叫 Anthropic Messages API（不透過 claude -p），比較 Claude 5.5 系列。
// 用法完即丟，不是正式實作。用原生 fetch，跟 Chrome 外掛裡會寫的程式一樣（不需要 npm install）。
//
// 用法：ANTHROPIC_API_KEY=... node run.mjs <runName> --model haiku|sonnet|opus --input image|text
//          [--effort low] [--thinking off] [--notes series-notes.md] [--cache] [ids...]
//   --input image  整頁 PNG 給模型，回傳 bbox／原文／讀音／順序／譯文（同 #6）
//   --input text   只送本機 OCR 的文字（ocr-input/，取自 #7 的 webgpu-fp32），回傳讀音＋譯文（同 #7 --reading claude）
//   --thinking off haiku → {type:"disabled"}；sonnet → {type:"between_tools"}；opus 不能關（省略 = adaptive）
//   --cache        把 system prompt（＋Series Notes）標 cache_control，看能不能吃到 prompt cache
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "../../testdata/synthetic/out");
const ocrDir = join(here, "ocr-input");

const args = process.argv.slice(2);
const runName = args.shift();
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const MODELS = {
  haiku: { id: "claude-haiku-5-5", in: 0.1, out: 0.5, cacheRead: 0.01 },
  sonnet: { id: "claude-sonnet-5-5", in: 2, out: 10, cacheRead: 0.2 },
  opus: { id: "claude-opus-5-5", in: 4, out: 20, cacheRead: 0.2 },
};
const modelKey = opt("--model", "sonnet");
const model = MODELS[modelKey];
const input = opt("--input", "image");
const effort = opt("--effort", "low");
const thinkingOff = opt("--thinking", "on") === "off";
const notesPath = opt("--notes", null);
const cache = flag("--cache");
const srcDir = input === "text" ? ocrDir : dataDir;
const ids = args.length ? args : readdirSync(srcDir).filter((f) => /^p\d.*\.json$/.test(f)).map((f) => f.replace(/\.json$/, ""));
const outDir = join(here, "results", runName);
mkdirSync(outDir, { recursive: true });

// key 只從環境變數來，執行時用 1Password CLI 注入：
//   ANTHROPIC_API_KEY=op://Private/manga-translator-claude-key/credential op run -- node run.mjs ...
const key = process.env.ANTHROPIC_API_KEY;
if (!key) throw new Error("需要 ANTHROPIC_API_KEY 環境變數（用 op run 注入）");

// structured outputs：每個 object 都要 additionalProperties:false，不支援 minItems/maxItems 這類陣列限制
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const imageItem = obj({
  order: { type: "integer", description: "全頁閱讀順序，1 起算" },
  kind: { type: "string", enum: ["balloon", "thought", "narration", "sfx", "sign", "outside"] },
  bbox: { type: "array", items: { type: "integer" }, description: "[x, y, width, height]，圖片像素，原點左上；有外框時框住整個 Balloon / 旁白框" },
  orientation: { type: "string", enum: ["vertical", "horizontal"] },
  ja: { type: "string", description: "日文原文，不含振り仮名，不含換行" },
  reading: { type: "string", description: "整句讀音（假名）；有振り仮名時以振り仮名為準" },
  zh: { type: "string", description: "繁體中文（台灣）譯文" },
});
const textItem = obj({
  order: { type: "integer" },
  reading: { type: "string", description: "整句假名讀音" },
  zh: { type: "string", description: "繁體中文（台灣）譯文" },
});
const schema = obj({ texts: { type: "array", items: input === "text" ? textItem : imageItem } });

// prompt 沿用 #6（image）與 #7 --reading claude（text），方便跟舊數字比
const systemImage = `你是日文漫畫翻譯助手。使用者會給你一張漫畫 Page 圖片，請找出圖中所有日文文字
（對話 Balloon、思考泡泡、旁白框、狀聲詞、招牌或物件上的字、Balloon 外的手寫小字），
依照日本漫畫的閱讀順序（右上到左下；雙頁時先右頁再左頁）排序，逐一回傳：
- bbox：[x, y, width, height]，以圖片像素為單位、原點在左上。有外框（Balloon、旁白框）就框住整個外框；沒有外框就框住文字本身。
- kind：balloon / thought / narration / sfx / sign / outside
- orientation：vertical（直書）或 horizontal（橫書）
- ja：日文原文（不含振り仮名，換行直接接起來）
- reading：整句的假名讀音，有振り仮名時以振り仮名為準
- zh：自然的台灣繁體中文譯文
只輸出符合 schema 的 JSON。`;
const systemText = `你是日文漫畫翻譯助手。使用者會給你一張漫畫 Page 上、已經用 OCR 讀出來並依閱讀順序排好的日文文字（JSON）。
kind 是 balloon（對話框）或 outside（對話框外的文字，例如狀聲詞、旁白、招牌）。OCR 偶爾會有錯字，請依上下文理解。
請逐一回傳 order 與自然的台灣繁體中文譯文 zh，以及整句的假名讀音 reading（漢字一律寫成平假名）。
只輸出符合 schema 的 JSON。`;

// Series Notes 放在 system（每部作品固定），這樣才能跟 system prompt 一起被 cache
let systemText_ = input === "text" ? systemText : systemImage;
if (notesPath) systemText_ += `\n\n以下是這部作品的 Series Notes，翻譯時請遵守：\n${readFileSync(join(here, notesPath), "utf8")}`;
const system = [{ type: "text", text: systemText_, ...(cache ? { cache_control: { type: "ephemeral" } } : {}) }];

function userContent(id) {
  if (input === "text") {
    const rec = JSON.parse(readFileSync(join(ocrDir, `${id}.json`), "utf8"));
    return { rec, content: [{ type: "text", text: JSON.stringify(rec.output.texts.map(({ order, kind, ja }) => ({ order, kind, ja }))) }] };
  }
  const gt = JSON.parse(readFileSync(join(dataDir, `${id}.json`), "utf8"));
  const png = readFileSync(join(dataDir, `${id}.png`));
  return {
    imageSize: [gt.width, gt.height],
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
      { type: "text", text: `這張圖片的尺寸是 ${gt.width}×${gt.height} 像素。` },
    ],
  };
}

async function call(body) {
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2026-10-21",
        // Chrome 外掛直接呼叫時需要這個 header 才會拿到 CORS 回應；Node 裡帶著無害，順便確認它不影響行為
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    const ms = performance.now() - t0;
    const json = await res.json();
    if (res.ok) return { json, ms };
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = Number(res.headers.get("retry-after") ?? 2 ** attempt * 2);
      console.error(`  ${res.status}，${wait}s 後重試`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    throw new Error(`${res.status} ${JSON.stringify(json)}`);
  }
}

function costOf(u) {
  const w = u.cache_creation_input_tokens ?? 0, r = u.cache_read_input_tokens ?? 0;
  return ((u.input_tokens ?? 0) * model.in + w * model.in * 1.25 + r * model.cacheRead + (u.output_tokens ?? 0) * model.out) / 1e6;
}

for (const id of ids) {
  const { rec: ocrRec, content, imageSize } = userContent(id);
  const body = {
    model: model.id,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content }],
    output_config: { effort, format: { type: "json_schema", schema } },
  };
  if (thinkingOff) {
    if (modelKey === "haiku") body.thinking = { type: "disabled" };
    else if (modelKey === "sonnet") body.thinking = { type: "between_tools" };
    else throw new Error("Opus 5.5 不能關 thinking");
  }
  const { json, ms } = await call(body);
  const textBlock = json.content.find((b) => b.type === "text");
  let out = null;
  try { out = JSON.parse(textBlock?.text ?? ""); } catch {}
  let rec;
  if (input === "text") {
    // 本機 OCR 的 bbox / 原文 / 順序，加上 Claude 的讀音與譯文 → 給 score.mjs 用同一格式評分
    rec = structuredClone(ocrRec);
    const byOrder = new Map((out?.texts ?? []).map((t) => [t.order, t]));
    for (const t of rec.output.texts) {
      const r = byOrder.get(t.order);
      t.zh = r?.zh ?? "";
      t.readingKuromoji = t.reading;
      t.reading = r?.reading ?? t.reading;
    }
    rec.latency = { localMs: ocrRec.latency.wallMs, turnMs: Math.round(ms), wallMs: Math.round(ocrRec.latency.wallMs + ms) };
  } else {
    rec = { id, imageSize, output: out, latency: { turnMs: Math.round(ms), wallMs: Math.round(ms) } };
  }
  Object.assign(rec, {
    model: model.id, input, effort, thinking: body.thinking?.type ?? "adaptive", notes: notesPath, cache,
    usage: json.usage, costUsd: costOf(json.usage), stopReason: json.stop_reason,
    thinkingBlocks: json.content.filter((b) => b.type === "thinking").length,
    rawText: out ? undefined : textBlock?.text,
  });
  writeFileSync(join(outDir, `${id}.json`), JSON.stringify(rec, null, 2));
  const u = json.usage;
  console.log(`${id}: ${(ms / 1000).toFixed(1)}s in ${u.input_tokens}+cw${u.cache_creation_input_tokens ?? 0}+cr${u.cache_read_input_tokens ?? 0} out ${u.output_tokens} $${rec.costUsd.toFixed(5)} texts ${out?.texts?.length ?? "PARSE FAIL"} ${json.stop_reason}`);
}
