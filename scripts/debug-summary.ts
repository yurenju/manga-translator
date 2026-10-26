/**
 * 摘要一次除錯錄製（scripts/debug-chrome.ts）：事件數量＋精簡時間軸。
 *   npm run debug:summary                     最新一次 session
 *   npm run debug:summary -- 20261026-152342  指定 session（名稱或資料夾路徑）
 *   npm run debug:summary -- --grep overlay   只列事件名稱含這段字的
 * 每行開頭是 trace.jsonl 的行號，要看完整記錄（例如 LLM 的回應）就去讀那一行。
 */
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DEBUG_DIR } from './debug-chrome.ts';
import { latestSession, summarize, type SessionRecord } from './debug-session.ts';

const args = process.argv.slice(2);
const grepAt = args.indexOf('--grep');
const grep = grepAt === -1 ? undefined : args[grepAt + 1];
const session = args.find((arg, i) => !arg.startsWith('--') && i !== grepAt + 1) ?? latestSession(await readdir(DEBUG_DIR));
if (session === undefined) throw new Error(`${DEBUG_DIR} 裡還沒有錄製記錄`);
const dir = isAbsolute(session) ? session : join(DEBUG_DIR, session);

const text = await readFile(join(dir, 'trace.jsonl'), 'utf8');
const records = text
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as SessionRecord);

const counts: Record<string, number> = {};
for (const r of records) counts[`${r.ctx}:${r.event}`] = (counts[`${r.ctx}:${r.event}`] ?? 0) + 1;
console.log(`session ${dir}（${records.length} 筆）`);
console.log(Object.entries(counts).map(([event, n]) => `${event} ×${n}`).join('  '));
console.log('');
for (const line of summarize(records)) if (grep === undefined || line.split(' ').filter(Boolean)[3]?.includes(grep)) console.log(line);
