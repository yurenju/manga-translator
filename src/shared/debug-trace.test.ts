import { describe, expect, it } from 'vitest';
import { formatTrace, parseTrace, TRACE_PREFIX } from './debug-trace.ts';

describe('formatTrace／parseTrace', () => {
  it('一筆記錄是前綴＋JSON，錄製端可以原樣解回來', () => {
    const line = formatTrace('sw', 'capture', { tabId: 3 }, 1000);

    expect(line.startsWith(`${TRACE_PREFIX} `)).toBe(true);
    expect(parseTrace(line)).toEqual({ ctx: 'sw', event: 'capture', at: 1000, data: { tabId: 3 } });
  });

  it('沒有前綴的 console 訊息不是記錄', () => {
    expect(parseTrace('translate failed')).toBeUndefined();
    expect(parseTrace(`${TRACE_PREFIX} not json`)).toBeUndefined();
  });

  it('Error 轉成 message 與 stack（JSON.stringify 預設會變成 {}）', () => {
    const error = new Error('boom');

    const record = parseTrace(formatTrace('offscreen', 'translate:error', { error }, 0));

    expect(record?.data).toMatchObject({ error: { message: 'boom' } });
    expect((record?.data as { error: { stack: string } }).error.stack).toContain('boom');
  });
});
