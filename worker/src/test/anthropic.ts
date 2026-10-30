/** Worker 測試共用的假 Anthropic：vi.spyOn(fetch) 依序回傳準備好的回應。 */
import { vi } from 'vitest';
import { CLAUDE_MODEL } from '../../../src/shared/claude-request.ts';

export const usage = { input_tokens: 300, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 700 };

/** Anthropic 的成功回應，內容是 answer 的 JSON。 */
export const reply = (answer: unknown) => () =>
  Response.json({ model: CLAUDE_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }], usage });

/** 依序回傳 responses，記下每次送出的網址、init 與 body。 */
export function fakeAnthropic(responses: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init = {}) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body as string) });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return next();
  });
  return { calls };
}
