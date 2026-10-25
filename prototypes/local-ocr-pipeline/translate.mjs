// PROTOTYPE（#7）：把本機 OCR 的結果（純文字，不送圖）交給常駐的 Claude Code 翻譯。
// 呼叫方式沿用 #6 的 run.mjs（stream-json、--json-schema、--tools ""、cwd 在 tmp）。
//
// 用法：node translate.mjs <ocrRun> <newRun> [--model sonnet] [--reading kuromoji|claude] [--notes notes.md] [--fresh] [ids...]
//   --reading claude  也請 Claude 回傳讀音，取代 kuromoji 的讀音（比較兩者）
//   --fresh           每頁新開一個 claude（含冷啟動）；預設一個常駐 claude 處理所有 Page
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ocrRun = args.shift();
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
const model = opt("--model", "sonnet");
const readingFrom = opt("--reading", "kuromoji");
const notesPath = opt("--notes", null);
const fresh = flag("--fresh");
const srcDir = join(here, "results", ocrRun);
const ids = args.length ? args : readdirSync(srcDir).filter((f) => /^p\d.*\.json$/.test(f)).map((f) => f.replace(/\.json$/, ""));
const outDir = join(here, "results", runName);
mkdirSync(outDir, { recursive: true });

const item = { order: { type: "integer" }, zh: { type: "string", description: "繁體中文（台灣）譯文" } };
if (readingFrom === "claude") item.reading = { type: "string", description: "整句假名讀音" };
const schema = {
  type: "object",
  properties: { texts: { type: "array", items: { type: "object", properties: item, required: Object.keys(item) } } },
  required: ["texts"],
};
const systemPrompt = `你是日文漫畫翻譯助手。使用者會給你一張漫畫 Page 上、已經用 OCR 讀出來並依閱讀順序排好的日文文字（JSON）。
kind 是 balloon（對話框）或 outside（對話框外的文字，例如狀聲詞、旁白、招牌）。OCR 偶爾會有錯字，請依上下文理解。
請逐一回傳 order 與自然的台灣繁體中文譯文 zh${readingFrom === "claude" ? "，以及整句的假名讀音 reading（漢字一律寫成平假名）" : ""}。
只輸出符合 schema 的 JSON。`;

function startClaude() {
  const cliArgs = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--model", model, "--system-prompt", systemPrompt, "--json-schema", JSON.stringify(schema),
    "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence",
  ];
  const child = spawn("claude", cliArgs, { cwd: tmpdir() });
  let buf = "";
  const waiters = [];
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "result") waiters.shift()?.(ev);
    }
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  return {
    send(text) {
      return new Promise((resolve) => {
        waiters.push(resolve);
        child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
      });
    },
    close() { child.stdin.end(); },
  };
}
function parseOutput(result) {
  if (result.structured_output) return result.structured_output;
  const m = String(result.result ?? "").match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

async function runPage(claude, id, spawnedAt) {
  const rec = JSON.parse(readFileSync(join(srcDir, `${id}.json`), "utf8"));
  let text = JSON.stringify(rec.output.texts.map(({ order, kind, ja }) => ({ order, kind, ja })));
  if (notesPath) text += `\n\n以下是這部作品的 Series Notes，翻譯時請遵守：\n${readFileSync(notesPath, "utf8")}`;
  const t0 = performance.now();
  const result = await claude.send(text);
  const t1 = performance.now();
  const out = parseOutput(result);
  const byOrder = new Map((out?.texts ?? []).map((t) => [t.order, t]));
  for (const t of rec.output.texts) {
    const r = byOrder.get(t.order);
    t.zh = r?.zh ?? "";
    if (readingFrom === "claude" && r?.reading) (t.readingKuromoji = t.reading), (t.reading = r.reading);
  }
  const localMs = rec.latency.wallMs;
  Object.assign(rec, { model, readingFrom, resident: !fresh, notes: notesPath });
  rec.latency = {
    ...rec.latency,
    localMs,
    turnMs: Math.round(t1 - t0),
    // 整頁端到端 = 本機 OCR（中位數）＋ 翻譯 turn；每頁新開時另含冷啟動
    wallMs: Math.round(localMs + (t1 - (spawnedAt ?? t0))),
    durationMs: result.duration_ms,
    durationApiMs: result.duration_api_ms,
  };
  rec.usage = result.usage;
  rec.modelUsage = result.modelUsage;
  rec.costUsd = result.total_cost_usd;
  rec.isError = result.is_error;
  writeFileSync(join(outDir, `${id}.json`), JSON.stringify(rec, null, 2));
  const u = result.usage ?? {};
  console.log(`${id}: local ${localMs}ms turn ${rec.latency.turnMs}ms in ${(u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)} out ${u.output_tokens} $${rec.costUsd} ${out ? "" : "PARSE FAIL"}`);
}

if (fresh) {
  for (const id of ids) {
    const spawnedAt = performance.now();
    const claude = startClaude();
    await runPage(claude, id, spawnedAt);
    claude.close();
  }
} else {
  const claude = startClaude();
  // 常駐：先暖機一次（冷啟動不算進每頁延遲，跟 #2 的「常駐 bridge」假設一致）
  await claude.send("ping，回傳空的 texts 陣列即可。");
  for (const id of ids) await runPage(claude, id, null);
  claude.close();
}
