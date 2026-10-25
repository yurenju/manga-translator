// PROTOTYPE（#7）：給 browser.html 用的 static server（只聽 127.0.0.1）。
// 設 COOP/COEP 讓頁面 crossOriginIsolated，onnxruntime-web 的 wasm 才能開多執行緒。
// POST /save/<run>/<id> 會把頁面量到的結果寫進 results/<run>/<id>.json（格式同 ocr.mjs）。
// 用法：node serve.mjs [port=8787]  → 開 http://localhost:8787/browser.html?ep=webgpu&ocr=fp32
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../.."); // repo 根目錄，才拿得到 testdata/
const port = Number(process.argv[2] ?? 8787);
const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".gz": "application/octet-stream", ".txt": "text/plain" };

createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  const url = new URL(req.url, "http://x");
  try {
    const m = url.pathname.match(/^\/save\/([\w.+-]+)\/([\w-]+)$/);
    if (req.method === "POST" && m) {
      let body = "";
      for await (const c of req) body += c;
      await mkdir(join(here, "results", m[1]), { recursive: true });
      await writeFile(join(here, "results", m[1], `${m[2]}.json`), JSON.stringify(JSON.parse(body), null, 2));
      return res.end("ok");
    }
    // /testdata/... 從 repo 根目錄拿，其餘從 prototype 目錄拿
    const base = url.pathname.startsWith("/testdata/") ? root : here;
    const p = normalize(join(base, decodeURIComponent(url.pathname)));
    if (!p.startsWith(base)) throw new Error("outside root");
    const data = await readFile(p);
    res.setHeader("Content-Type", TYPES[extname(p)] ?? "application/octet-stream");
    res.end(data);
  } catch (e) {
    res.statusCode = 404;
    res.end(String(e));
  }
}).listen(port, "127.0.0.1", () => console.log(`http://localhost:${port}/browser.html`));
