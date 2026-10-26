/**
 * 除錯記錄的格式（debug build 才有）：每個 context 把流水線事件印成 console.debug（./trace.ts），
 * 由 scripts/debug-chrome.ts 透過 CDP 收進 trace.jsonl。
 *
 * 值是 data:image/ 開頭的字串時，錄製端會存成圖片檔、記錄裡只留路徑。API key 不要放進記錄。
 */

export type TraceContext = 'sw' | 'offscreen' | 'content';

export const TRACE_PREFIX = '[manga-trace]';

export interface TraceRecord {
  ctx: TraceContext;
  event: string;
  at: number;
  data: Record<string, unknown>;
}

/** JSON.stringify 會把 Error 變成 {}，先轉成看得懂的形狀。 */
function replacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
}

export function formatTrace(ctx: TraceContext, event: string, data: Record<string, unknown>, at: number): string {
  return `${TRACE_PREFIX} ${JSON.stringify({ ctx, event, at, data } satisfies TraceRecord, replacer)}`;
}

/** console 訊息不是記錄（沒有前綴或解不開）就回傳 undefined。 */
export function parseTrace(text: string): TraceRecord | undefined {
  if (!text.startsWith(`${TRACE_PREFIX} `)) return undefined;
  try {
    return JSON.parse(text.slice(TRACE_PREFIX.length + 1)) as TraceRecord;
  } catch {
    return undefined;
  }
}
