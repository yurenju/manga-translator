/**
 * 印除錯記錄（格式見 ./debug-trace.ts）。跟格式分成兩個模組：正式與 e2e build 裡 __DEBUG__ 是 false，
 * 下面只剩死分支引用 debug-trace.ts，esbuild 就不會把它打包進來（scripts/build.test.ts 有檢查）。
 */
import { formatTrace, type TraceContext } from './debug-trace.ts';

export type Trace = (event: string, data?: Record<string, unknown>) => void;

/** 每個 context 建一個；正式與 e2e build 回傳空函式。 */
export function createTrace(ctx: TraceContext): Trace {
  // 要寫成 if (__DEBUG__)：esbuild 會摺疊 if (false)，但不會丟掉 return 之後到不了的程式碼
  if (__DEBUG__) return (event, data = {}) => console.debug(formatTrace(ctx, event, data, Date.now()));
  return () => {};
}
