// PROTOTYPE（#6）：產生 viewer.html，把 GT 框（綠）與 Claude 預測框（紅）疊在合成 Page 上。
// 用法：node viewer.mjs <runName> [<runName>...]   → 開 viewer.html（直接雙擊）
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runs = process.argv.slice(2);
const data = runs.map((run) => ({
  run,
  pages: readdirSync(join(here, "results", run)).filter((f) => /^p\d.*\.json$/.test(f)).map((f) => {
    const rec = JSON.parse(readFileSync(join(here, "results", run, f), "utf8"));
    const gt = JSON.parse(readFileSync(join(here, "../../testdata/synthetic/out", f), "utf8"));
    return { id: rec.id, w: gt.width, h: gt.height, gt: gt.texts, pred: rec.output?.texts ?? [], latency: rec.latency, cost: rec.costUsd };
  }),
}));
const html = `<!doctype html><meta charset="utf-8"><title>PROTOTYPE #6 viewer</title>
<style>body{font-family:sans-serif;margin:16px}svg{max-width:100%;height:auto;border:1px solid #ccc}
.page{display:flex;gap:16px;align-items:flex-start;margin-bottom:32px}.page>div:first-child{flex:0 0 45%}
table{border-collapse:collapse;font-size:13px}td,th{border:1px solid #ddd;padding:2px 6px;vertical-align:top}</style>
<h1>PROTOTYPE #6：Claude 看圖翻整頁</h1><p>綠＝ground truth，紅＝Claude（數字是 Claude 給的閱讀順序）</p>
<select id="run">${runs.map((r) => `<option>${r}</option>`).join("")}</select><div id="out"></div>
<script>const DATA=${JSON.stringify(data)};
const box=(b,c,label)=>'<rect x="'+b[0]+'" y="'+b[1]+'" width="'+b[2]+'" height="'+b[3]+'" fill="none" stroke="'+c+'" stroke-width="3"/>'+(label?'<text x="'+(b[0]+2)+'" y="'+(b[1]+22)+'" fill="'+c+'" font-size="22" font-weight="bold">'+label+'</text>':'');
function render(){const r=DATA.find(d=>d.run===run.value);out.innerHTML=r.pages.map(p=>'<div class="page"><div><h2>'+p.id+'</h2><p>turn '+(p.latency.turnMs/1000).toFixed(1)+' s · $'+p.cost.toFixed(3)+'</p><svg viewBox="0 0 '+p.w+' '+p.h+'"><image href="../../testdata/synthetic/out/'+p.id+'.png" width="'+p.w+'" height="'+p.h+'"/>'+p.gt.map(t=>box(t.bbox,"#0a0")).join("")+p.pred.map(t=>box(t.bbox,"#e00",t.order)).join("")+'</svg></div><table><tr><th>#</th><th>kind</th><th>ja</th><th>reading</th><th>zh</th></tr>'+p.pred.map(t=>'<tr><td>'+t.order+'</td><td>'+t.kind+'</td><td>'+t.ja+'</td><td>'+t.reading+'</td><td>'+t.zh+'</td></tr>').join("")+'</table></div>').join("")}
run.onchange=render;render();</script>`;
writeFileSync(join(here, "viewer.html"), html);
console.log("wrote viewer.html");
