import { defineConfig } from 'vitest/config';

// 第 4 層：呼叫真的 API（花錢、需要網路與 key），只在 `npm run smoke` 跑，不放進 `npm test`。
// 延遲、token、費用印在 console，所以通過時也顯示 log。
export default defineConfig({
  test: {
    include: ['src/**/*.smoke.ts'],
    reporters: ['verbose'],
    silent: false,
  },
});
