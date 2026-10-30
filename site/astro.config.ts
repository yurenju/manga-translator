import { defineConfig } from 'astro/config';

// 產品網站（#89）：先輸出純靜態頁面，跟 api. 的 Worker 分開部署。
// 共用外掛的 src/shared/tokens.css、logo 與根目錄的 PRIVACY.md，所以允許讀上一層。
export default defineConfig({
  server: { port: 4321 },
  vite: { server: { fs: { allow: ['..'] } } },
});
