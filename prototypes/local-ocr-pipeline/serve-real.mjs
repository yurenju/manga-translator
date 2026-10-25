// PROTOTYPE（#13）：給 real-compare.html 用的 static server（只聽 127.0.0.1），不存任何檔案。
// 跟 serve.mjs 一樣設 COOP/COEP；另外把 POST /anthropic 轉給 Anthropic Messages API，
// key 只從環境變數來（用 1Password CLI 注入），不會出現在頁面或檔案裡：
//   ANTHROPIC_API_KEY=op://Private/manga-translator-claude-key/credential op run -- node serve-real.mjs
// 沒有 /save：真實頁面的截圖與輸出只活在瀏覽器記憶體裡，關掉分頁就沒了。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 8788);
const key = process.env.ANTHROPIC_API_KEY;
if (!key) throw new Error("需要 ANTHROPIC_API_KEY 環境變數（用 op run 注入）");
const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".gz": "application/octet-stream", ".txt": "text/plain" };

createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "POST" && url.pathname === "/anthropic") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2026-10-21" },
        body: Buffer.concat(chunks),
      });
      res.statusCode = r.status;
      res.setHeader("Content-Type", "application/json");
      return res.end(await r.text());
    }
    const p = normalize(join(here, decodeURIComponent(url.pathname)));
    if (!p.startsWith(here)) throw new Error("outside root");
    const data = await readFile(p);
    res.setHeader("Content-Type", TYPES[extname(p)] ?? "application/octet-stream");
    res.end(data);
  } catch (e) {
    res.statusCode = 404;
    res.end(String(e));
  }
}).listen(port, "127.0.0.1", () => console.log(`http://localhost:${port}/real-compare.html`));
