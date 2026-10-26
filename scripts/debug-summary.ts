/**
 * 摘要一次除錯錄製（scripts/debug-chrome.ts）：事件數量＋精簡時間軸。
 *   npm run debug:summary                     最新一次 session
 *   npm run debug:summary -- 20261026-152342  指定 session（名稱或資料夾路徑）
 *   npm run debug:summary -- --grep overlay   只列事件名稱含這段字的
 *   npm run debug:summary -- --since 120      只列 trace.jsonl 第 120 行之後的（接著上次讀到的地方看）
 * 每行開頭是 trace.jsonl 的行號，要看完整記錄（例如 LLM 的回應、rect、截圖路徑）就去讀那一行。
 */
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DEBUG_DIR } from './debug-chrome.ts';
import { latestSession, summarize, type SessionRecord } from './debug-session.ts';

const args = process.argv.slice(2);
const valueOf = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const grep = valueOf('--grep');
const since = Number(valueOf('--since') ?? 0);
if (!Number.isInteger(since) || since < 0) throw new Error(`--since 要是行號：${valueOf('--since')}`);
const optionValues = new Set(['--grep', '--since'].map((name) => args.indexOf(name) + 1).filter((at) => at > 0));
const session = args.find((arg, i) => !arg.startsWith('--') && !optionValues.has(i)) ?? latestSession(await readdir(DEBUG_DIR));
if (session === undefined) throw new Error(`${DEBUG_DIR} 裡還沒有錄製記錄`);
const dir = isAbsolute(session) ? session : join(DEBUG_DIR, session);

const text = await readFile(join(dir, 'trace.jsonl'), 'utf8');
const records = text
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as SessionRecord);

const counts: Record<string, number> = {};
for (const r of records.slice(since)) counts[`${r.ctx}:${r.event}`] = (counts[`${r.ctx}:${r.event}`] ?? 0) + 1;
console.log(`session ${dir}（${records.length} 筆${since > 0 ? `，列第 ${since} 行之後的` : ''}）`);
console.log(Object.entries(counts).map(([event, n]) => `${event} ×${n}`).join('  '));
console.log('');
for (const line of summarize(records, { since })) if (grep === undefined || line.split(' ').filter(Boolean)[3]?.includes(grep)) console.log(line);
