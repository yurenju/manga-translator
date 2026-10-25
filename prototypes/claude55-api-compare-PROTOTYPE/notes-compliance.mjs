// PROTOTYPE（#6）：檢查譯文有沒有照 Series Notes 的指定譯名。
// 用法：node notes-compliance.mjs <runName> [<runName>...]
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// [頁, 原文中會出現的詞, 譯文必須含的字串]
const terms = [
  ["p02-ruby", "霧島湊", "霧島湊"],
  ["p02-ruby", "潮見坂", "潮見坂高中"],
  ["p02-ruby", "相棒", "拍檔"],
  ["p04-outside", "ひだまりベーカリー", "日向麵包坊"],
  ["p05-dense", "兄ちゃん", "老哥"],
  ["p05-dense", "カップ麺", "杯麵"],
  ["p05-dense", "当番", "值日"],
  ["p06-horizontal", "ミオ", "美緒"],
];
for (const run of process.argv.slice(2)) {
  let ok = 0, n = 0;
  const rows = [];
  for (const [id, ja, want] of terms) {
    const f = join(here, "results", run, `${id}.json`);
    if (!existsSync(f)) continue;
    const texts = JSON.parse(readFileSync(f, "utf8")).output?.texts ?? [];
    const t = texts.find((t) => t.ja.replace(/\s/g, "").includes(ja));
    const hit = !!t?.zh.includes(want);
    n++; if (hit) ok++;
    rows.push(`  ${hit ? "✓" : "✗"} ${ja} → 要「${want}」，得到「${t?.zh ?? "（沒找到這句）"}」`);
  }
  console.log(`${run}: ${ok}/${n}\n${rows.join("\n")}`);
}
