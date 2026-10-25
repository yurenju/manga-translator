// PROTOTYPE（#6）：把整張合成 Page 丟給本機 Claude Code，要它一次回傳所有文字的
// 座標、原文、讀音、閱讀順序與譯文。用完即丟，不是正式實作。
//
// 用法：node run.mjs <runName> [--model sonnet] [--scale 1] [--notes notes.md] [--resident] [ids...]
//   --resident  一個常駐 claude 處理所有 Page（量常駐延遲；注意對話脈絡會累積）
//   預設        每頁開一個新的 claude（量冷啟動＋單頁，脈絡乾淨）
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "../../testdata/synthetic/out");

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
const model = opt("--model", "sonnet");
const scale = Number(opt("--scale", "1"));
const notesPath = opt("--notes", null);
const effort = opt("--effort", null);
const resident = flag("--resident");
const ids = args.length
  ? args
  : readdirSync(dataDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

const outDir = join(here, "results", runName);
mkdirSync(outDir, { recursive: true });

const schema = {
  type: "object",
  properties: {
    texts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          order: { type: "integer", description: "全頁閱讀順序，1 起算" },
          kind: { type: "string", enum: ["balloon", "thought", "narration", "sfx", "sign", "outside"] },
          bbox: {
            type: "array",
            items: { type: "integer" },
            minItems: 4,
            maxItems: 4,
            description: "[x, y, width, height]，圖片像素，原點左上；有外框時框住整個 Balloon / 旁白框",
          },
          orientation: { type: "string", enum: ["vertical", "horizontal"] },
          ja: { type: "string", description: "日文原文，不含振り仮名，不含換行" },
          reading: { type: "string", description: "整句讀音（假名）；有振り仮名時以振り仮名為準" },
          zh: { type: "string", description: "繁體中文（台灣）譯文" },
        },
        required: ["order", "kind", "bbox", "orientation", "ja", "reading", "zh"],
      },
    },
  },
  required: ["texts"],
};

const systemPrompt = `你是日文漫畫翻譯助手。使用者會給你一張漫畫 Page 圖片，請找出圖中所有日文文字
（對話 Balloon、思考泡泡、旁白框、狀聲詞、招牌或物件上的字、Balloon 外的手寫小字），
依照日本漫畫的閱讀順序（右上到左下；雙頁時先右頁再左頁）排序，逐一回傳：
- bbox：[x, y, width, height]，以圖片像素為單位、原點在左上。有外框（Balloon、旁白框）就框住整個外框；沒有外框就框住文字本身。
- kind：balloon / thought / narration / sfx / sign / outside
- orientation：vertical（直書）或 horizontal（橫書）
- ja：日文原文（不含振り仮名，換行直接接起來）
- reading：整句的假名讀音，有振り仮名時以振り仮名為準
- zh：自然的台灣繁體中文譯文
只輸出符合 schema 的 JSON。`;

function userMessage(id) {
  const gt = JSON.parse(readFileSync(join(dataDir, `${id}.json`), "utf8"));
  let png = readFileSync(join(dataDir, `${id}.png`));
  let w = gt.width, h = gt.height;
  if (scale !== 1) {
    png = readFileSync(join(here, "scaled", `${id}@${scale}.png`));
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  let text = `這張圖片的尺寸是 ${w}×${h} 像素。`;
  if (notesPath) text += `\n\n以下是這部作品的 Series Notes，翻譯時請遵守：\n${readFileSync(notesPath, "utf8")}`;
  return {
    msg: {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
          { type: "text", text },
        ],
      },
    },
    w,
    h,
  };
}

function startClaude() {
  const cliArgs = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--system-prompt", systemPrompt,
    "--json-schema", JSON.stringify(schema),
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
  if (effort) cliArgs.push("--effort", effort);
  // cwd 放在 tmp，避免讀到 repo 的 CLAUDE.md
  const child = spawn("claude", cliArgs, { cwd: tmpdir(), shell: process.platform === "win32" ? false : false });
  let buf = "";
  const waiters = [];
  const events = [];
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      events.push(ev);
      if (ev.type === "result") waiters.shift()?.(ev);
    }
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  return {
    child,
    events,
    send(msg) {
      return new Promise((resolve) => {
        waiters.push(resolve);
        child.stdin.write(JSON.stringify(msg) + "\n");
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
  const { msg, w, h } = userMessage(id);
  const t0 = performance.now();
  const result = await claude.send(msg);
  const t1 = performance.now();
  const out = parseOutput(result);
  // 縮圖時把座標換回原圖像素，評分才能直接比 ground truth
  if (out && scale !== 1) for (const t of out.texts) t.bbox = t.bbox.map((v) => Math.round(v / scale));
  const rec = {
    id, model, scale, resident, notes: notesPath, effort,
    imageSize: [w, h],
    latency: {
      wallMs: Math.round(t1 - (spawnedAt ?? t0)), // 每頁新開時含冷啟動
      turnMs: Math.round(t1 - t0),               // 送出訊息到拿到結果
      durationMs: result.duration_ms,
      durationApiMs: result.duration_api_ms,
    },
    usage: result.usage,
    modelUsage: result.modelUsage,
    costUsd: result.total_cost_usd,
    isError: result.is_error,
    subtype: result.subtype,
    output: out,
    rawResult: out ? undefined : result.result,
  };
  writeFileSync(join(outDir, `${id}.json`), JSON.stringify(rec, null, 2));
  console.log(`${id}: wall ${rec.latency.wallMs}ms turn ${rec.latency.turnMs}ms texts ${out?.texts?.length ?? "PARSE FAIL"} cost $${rec.costUsd}`);
}

if (resident) {
  const spawnedAt = performance.now();
  const claude = startClaude();
  for (const [i, id] of ids.entries()) await runPage(claude, id, i === 0 ? spawnedAt : null);
  claude.close();
} else {
  for (const id of ids) {
    const spawnedAt = performance.now();
    const claude = startClaude();
    await runPage(claude, id, spawnedAt);
    claude.close();
  }
}
