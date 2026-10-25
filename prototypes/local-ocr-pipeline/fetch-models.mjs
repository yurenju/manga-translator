// PROTOTYPE（#7）：從 Hugging Face 下載實驗用的模型到 models/（已 gitignore）。
// 用法：node fetch-models.mjs   （約 900 MB；已存在的檔案會跳過）
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FILES = [
  ["ogkalu/comic-text-and-bubble-detector", "detector-v4-s_int8.onnx", "detector"],
  ["ogkalu/comic-text-and-bubble-detector", "detector.onnx", "detector"],
  ["onnx-community/manga-ocr-base-ONNX", "onnx/encoder_model.onnx", "ocr"],
  ["onnx-community/manga-ocr-base-ONNX", "onnx/decoder_model.onnx", "ocr"],
  ["onnx-community/manga-ocr-base-ONNX", "onnx/encoder_model_quantized.onnx", "ocr"],
  ["onnx-community/manga-ocr-base-ONNX", "onnx/decoder_model_quantized.onnx", "ocr"],
  ["kha-white/manga-ocr-base", "vocab.txt", "ocr"],
];
for (const [repo, file, dir] of FILES) {
  const out = join(here, "models", dir, file.split("/").pop());
  if (existsSync(out)) continue;
  mkdirSync(dirname(out), { recursive: true });
  process.stdout.write(`${repo}/${file} … `);
  const res = await fetch(`https://huggingface.co/${repo}/resolve/main/${file}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log("ok");
}
