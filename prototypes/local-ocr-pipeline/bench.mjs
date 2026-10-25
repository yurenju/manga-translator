// PROTOTYPE（#7）：在這台機器上跑一輪本機 OCR 的組合並印出分數（給 MacBook Air M2 用的一鍵版）。
// 用法：node bench.mjs <前綴，例如 m2>   → results/<前綴>-<組合>/ 與分數表
import { execFileSync } from "node:child_process";
import { listSupportedBackends } from "onnxruntime-node";
import os from "node:os";

const prefix = process.argv[2] ?? os.platform();
const backends = listSupportedBackends().map((b) => b.name);
console.log(`${os.cpus()[0].model} × ${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB, backends: ${backends.join(", ")}`);

const configs = [
  ["cpu-q8", ["--device", "cpu", "--ocr-dtype", "q8"]],
  ["cpu-fp32", ["--device", "cpu"]],
];
if (backends.includes("webgpu")) configs.push(["webgpu-fp32", ["--device", "webgpu"]], ["webgpu-fp32-detfp32", ["--device", "webgpu", "--det", "fp32"]]);
if (backends.includes("coreml")) configs.push(["coreml-fp32", ["--device", "coreml", "--det", "fp32"]]);
if (backends.includes("dml")) configs.push(["dml-fp32", ["--device", "dml", "--det", "fp32"]]);

const done = [];
for (const [name, args] of configs) {
  const run = `${prefix}-${name}`;
  console.log(`\n=== ${run}`);
  try {
    execFileSync(process.execPath, ["ocr.mjs", run, ...args], { stdio: "inherit" });
    done.push(run);
  } catch {
    console.log(`(${run} 失敗，略過)`);
  }
}
execFileSync(process.execPath, ["score.mjs", ...done], { stdio: "inherit" });
execFileSync(process.execPath, ["score-extra.mjs", ...done], { stdio: "inherit" });
