// PROTOTYPE（#14）：比較三種讓 LLM 拿到頁面振り仮名的方式。用完即丟，不是正式實作。
// 呼叫方式沿用 #15 的 run.mjs（原生 fetch 打 Messages API、structured outputs、effort low）。
//
// 用法：ANTHROPIC_API_KEY=op://Private/manga-translator-claude-key/credential op run -- \
//         node llm.mjs <rubyRun> <newRun> --hints none|ruby|image [--model haiku|sonnet] [ids...]
//   none   只送本機 OCR 的文字（= #9 決定的流水線，LLM 從文字推讀音）
//   ruby   每個 Balloon 多送本機讀到的ルビ（jaRuby，例：{本気|マジ}で…）當提示
//   image  本機有偵測到ルビ的 Balloon，另外附上該 Balloon 文字框的裁圖，請 LLM 自己看ルビ
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "../../testdata/synthetic/out");
const args = process.argv.slice(2);
const srcRun = args.shift();
const runName = args.shift();
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const MODELS = {
  haiku: { id: "claude-haiku-5-5", in: 0.1, out: 0.5 },
  sonnet: { id: "claude-sonnet-5-5", in: 2, out: 10 },
};
const modelKey = opt("--model", "haiku");
const model = MODELS[modelKey];
const hints = opt("--hints", "none");
const zoom = Number(opt("--zoom", "1")); // image 變體：裁圖放大倍數（ルビ只有 6–8 px，原尺寸 LLM 看不清楚）
const reps = Number(opt("--reps", "1"));
const srcDir = join(here, "results", srcRun);
const ids = args.length ? args : readdirSync(srcDir).filter((f) => /^p\d.*\.json$/.test(f)).map((f) => f.replace(/\.json$/, ""));
const outDir = join(here, "results", runName);
mkdirSync(outDir, { recursive: true });
const key = process.env.ANTHROPIC_API_KEY;
if (!key) throw new Error("需要 ANTHROPIC_API_KEY 環境變數（用 op run 注入）");

const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const schema = obj({
  texts: { type: "array", items: obj({
    order: { type: "integer" },
    reading: { type: "string", description: "整句假名讀音" },
    zh: { type: "string", description: "繁體中文（台灣）譯文" },
  }) },
});

// system 沿用 #15 的 text 模式，只依變體多一段說明
let system = `你是日文漫畫翻譯助手。使用者會給你一張漫畫 Page 上、已經用 OCR 讀出來並依閱讀順序排好的日文文字（JSON）。
kind 是 balloon（對話框）或 outside（對話框外的文字，例如狀聲詞、旁白、招牌）。OCR 偶爾會有錯字，請依上下文理解。
請逐一回傳 order 與自然的台灣繁體中文譯文 zh，以及整句的假名讀音 reading（漢字一律寫成平假名）。`;
if (hints === "ruby")
  system += `
有些項目附有 ruby：這是頁面上作者印的振り仮名，用 {漢字|讀音} 標在原文裡（由另一個 OCR 讀出，小字的濁點、促音、長音偶爾會錯，
漢字範圍也可能差一兩個字）。作者標的讀音優先於一般讀法（例如義訓、人名），reading 請依 ruby 寫，並用上下文修正明顯的 OCR 錯字。`;
if (hints === "image")
  system += `
有些項目後面附有該段文字的裁圖（圖前會標 order）。圖裡漢字旁邊的小字是作者印的振り仮名，作者標的讀音優先於一般讀法
（例如義訓、人名），reading 請依圖中的振り仮名寫。`;
system += "\n只輸出符合 schema 的 JSON。";

async function crop(buf, [x, y, w, h], IW, IH) {
  const pad = 6;
  const l = Math.max(0, Math.round(x) - pad), t = Math.max(0, Math.round(y) - pad);
  const width = Math.min(IW - l, Math.round(w) + 2 * pad), height = Math.min(IH - t, Math.round(h) + 2 * pad);
  return (await sharp(buf).extract({ left: l, top: t, width, height }).resize(width * zoom, height * zoom, { kernel: "lanczos3" }).png().toBuffer()).toString("base64");
}

async function call(body) {
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2026-10-21" },
      body: JSON.stringify(body),
    });
    const ms = performance.now() - t0;
    const json = await res.json();
    if (res.ok) return { json, ms };
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 2000));
      continue;
    }
    throw new Error(`${res.status} ${JSON.stringify(json)}`);
  }
}

for (const id of ids) {
  // 已經跑過的頁面跳過（中斷後可以接著跑）
  if (existsSync(join(outDir, `${id}.json`))) { console.log(`${id}: 已有結果，跳過`); continue; }
  const rec = JSON.parse(readFileSync(join(srcDir, `${id}.json`), "utf8"));
  const gt = JSON.parse(readFileSync(join(dataDir, `${id}.json`), "utf8"));
  const items = rec.output.texts.map((t) => {
    const it = { order: t.order, kind: t.kind, ja: t.ja };
    if (hints === "ruby" && t.rubyHints?.length) it.ruby = t.jaRuby;
    return it;
  });
  const content = [{ type: "text", text: JSON.stringify(items) }];
  let images = 0;
  if (hints === "image") {
    const png = readFileSync(join(dataDir, `${id}.png`));
    for (const t of rec.output.texts) {
      if (!t.rubyHints?.length) continue;
      content.push({ type: "text", text: `order ${t.order} 的裁圖：` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: await crop(png, t.textBbox, gt.width, gt.height) } });
      images++;
    }
  }
  const body = {
    model: model.id, max_tokens: 8000, system,
    messages: [{ role: "user", content }],
    output_config: { effort: "low", format: { type: "json_schema", schema } },
  };
  // 跑 reps 次：結果用最後一次，延遲取中位數
  const turns = [];
  let json;
  for (let k = 0; k < reps; k++) { const r = await call(body); json = r.json; turns.push(Math.round(r.ms)); }
  const ms = [...turns].sort((a, b) => a - b)[Math.floor(turns.length / 2)];
  let out = null;
  try { out = JSON.parse(json.content.find((b) => b.type === "text")?.text ?? ""); } catch {}
  const byOrder = new Map((out?.texts ?? []).map((t) => [t.order, t]));
  for (const t of rec.output.texts) {
    const r = byOrder.get(t.order);
    t.readingKuromoji = t.reading;
    t.reading = r?.reading ?? t.reading;
    t.zh = r?.zh ?? "";
  }
  const u = json.usage;
  rec.latency = { ...rec.latency, turnMs: Math.round(ms), turns };
  Object.assign(rec, { model: model.id, hints, zoom, images, usage: u, costUsd: (u.input_tokens * model.in + u.output_tokens * model.out) / 1e6 });
  writeFileSync(join(outDir, `${id}.json`), JSON.stringify(rec, null, 2));
  console.log(`${id}: ${(ms / 1000).toFixed(1)}s in ${u.input_tokens} out ${u.output_tokens} imgs ${images} $${rec.costUsd.toFixed(5)} ${out ? "" : "PARSE FAIL"}`);
}
