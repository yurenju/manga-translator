/**
 * 盤點時讀最新一次除錯錄製的 trace.jsonl：node .claude/skills/audit-extension/tools/trace.ts <指令> ...
 *   session                                  印出最新 session 名稱、資料夾與目前行數
 *   wait <event> [--since n] [--count k] [--timeout s]
 *                                            等到第 n 行之後出現 k 筆（預設 1）名稱含 event 的記錄，印出行號（預設 60 秒，逾時 exit 1）
 *   pairs [--since n]                        每組 translate:request／response 配成「原文 → 譯文」，附行號
 *   context [--since n]                      每個 translate:request 帶的 priorPages（每頁頭尾一句）與 Series Notes
 * 都可以加 --session <名稱> 指定別的 session。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEBUG_DIR } from '../../../../scripts/debug-chrome.ts';
import { latestSession } from '../../../../scripts/debug-session.ts';

interface Item {
  id: string;
  kind: string;
  orientation?: string;
  原文?: string;
  譯文?: string;
  unreadable?: boolean;
}

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const since = Number(option('--since') ?? 0);
const session = option('--session') ?? latestSession(readdirSync(DEBUG_DIR));
if (session === undefined) throw new Error(`${DEBUG_DIR} 裡還沒有錄製記錄；先在 Terminal 面板跑 npm run debug:chrome`);
const file = join(DEBUG_DIR, session, 'trace.jsonl');

/** 第 since 行之後的記錄，附 1 起算的行號。 */
function records(): { line: number; event: string; data: any }[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((text, i) => (i + 1 > since && text !== '' ? [{ line: i + 1, ...(JSON.parse(text) as { event: string; data: any }) }] : []));
}

/** request 與 response 照 item id 的集合配對：同時翻兩頁時 response 會交錯回來，先進先出會配錯。 */
function pairs(): string[] {
  const idsOf = (items: readonly Item[]) => items.map((it) => it.id).sort().join(',');
  const pending: { line: number; items: Item[] }[] = [];
  const out: string[] = [];
  for (const { line, event, data } of records()) {
    if (event === 'translate:request') pending.push({ line, items: data.input.items });
    if (event !== 'translate:response') continue;
    const translated: Item[] = data.output?.items ?? [];
    const at = pending.findIndex((request) => idsOf(request.items) === idsOf(translated));
    const request = at === -1 ? undefined : pending.splice(at, 1)[0];
    if (request === undefined) {
      out.push(`\n=== response L${line}：找不到 id 相同的 request（大概在 --since 之前）`);
      continue;
    }
    out.push(`\n=== request L${request.line} → response L${line}`);
    const byId = new Map(translated.map((it) => [it.id, it]));
    for (const it of request.items) {
      const t = byId.get(it.id);
      const tag = `${it.kind}${it.orientation === 'vertical' ? '|直' : ''}`;
      out.push(`${it.id} [${tag}] ${it.原文}  →  ${t?.unreadable ? '(unreadable)' : (t?.譯文 ?? '(無)')}`);
    }
  }
  return out;
}

/** 每個 translate:request 帶了哪些上下文：priorPages 每頁的頭尾一句、Series Notes。跨頁兩頁的 priorPages 一樣、暱稱和本名各記一條，都是從這裡看出來的。 */
function context(): string[] {
  const out: string[] = [];
  for (const { line, event, data } of records()) {
    if (event !== 'translate:request') continue;
    const { items, priorPages, seriesNotes } = data.input as {
      items: Item[];
      priorPages: { 原文: string }[][];
      seriesNotes: { 原文: string; 譯文: string }[];
    };
    out.push(`\n=== L${line} items ${items.length}，第一句 ${items[0]?.原文 ?? '(無)'}`);
    priorPages.forEach((page, i) => out.push(`  priorPages[${i}] ${page[0]?.原文 ?? ''} … ${page.at(-1)?.原文 ?? ''}`));
    if (seriesNotes.length > 0) out.push(`  notes ${seriesNotes.map((n) => `${n.原文}→${n.譯文}`).join('、')}`);
  }
  return out;
}

async function wait(event: string): Promise<string> {
  const deadline = Date.now() + Number(option('--timeout') ?? 60) * 1000;
  const count = Number(option('--count') ?? 1);
  while (Date.now() < deadline) {
    const hits = records().filter((r) => r.event.includes(event));
    if (hits.length >= count) return hits.slice(0, count).map((hit) => `L${hit.line} ${hit.event}`).join('\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  process.exitCode = 1;
  return `逾時：L${since} 之後不到 ${count} 筆 ${event}（目前 ${readFileSync(file, 'utf8').split('\n').length - 1} 行）`;
}

switch (args[0]) {
  case 'session':
    console.log(`${session}\n${join(DEBUG_DIR, session)}\n${readFileSync(file, 'utf8').split('\n').length - 1} 行`);
    break;
  case 'wait':
    console.log(await wait(args[1] ?? 'overlay:show'));
    break;
  case 'pairs':
    console.log(pairs().join('\n'));
    break;
  case 'context':
    console.log(context().join('\n'));
    break;
  default:
    throw new Error(`未知指令 ${args[0]}；用法見 ${import.meta.filename} 開頭`);
}
