import { defineConfig } from 'vitest/config';

export default defineConfig({
  // build 時的常數（scripts/build.ts）；單元測試當正式 build
  define: { __E2E__: 'false', __DEBUG__: 'false' },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'site/src/**/*.test.ts'],
  },
});
