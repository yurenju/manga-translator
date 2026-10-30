/**
 * 在開著的 debug Chrome（npm run debug:chrome）裡，不靠點擊操作外掛（#112）：
 *   npm run debug:panel      把漫畫分頁的 side panel 開成獨立視窗（真的 side panel 要使用者手勢才打得開）
 *   npm run debug:activate   打開（或沿用）那個 side panel 視窗，再送 test:activate，等同點外掛圖示
 *
 * debug build 跟 e2e build 一樣有 <all_urls> 與 test:activate，啟動不需要 activeTab。
 * 所以只跟 activeTab 有關的 bug 這樣重現不了，要請使用者點圖示（docs/agents/real-site-debugging.md）。
 *
 * 選項：--url <字串>（挑 url 含它的分頁；沒給就用最後聚焦視窗的作用中分頁）、--port <n>
 */
import { connectCdp, extensionId, isListening, type Cdp } from './debug-chrome.ts';
import { panelTarget, pickMangaTab, type ChromeTab } from './debug-targets.ts';

const DEFAULT_PORT = 9222;
const COMMANDS = ['panel', 'activate'] as const;
type Command = (typeof COMMANDS)[number];
/** 真的 side panel 大約這麼寬，版面才接近。 */
const PANEL_WINDOW = { width: 400, height: 900 };
const ACTIVATE_TIMEOUT_MS = 30_000;

/** attach 到一個 target，在它的 main world 執行可 await 的運算式。 */
async function attachPage(cdp: Cdp, targetId: string) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return async (expression: string): Promise<any> => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
}

/** 等條件成立；逾時回傳 false。 */
async function poll(check: () => Promise<boolean>, tries = 50, intervalMs = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await check().catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!(COMMANDS as readonly string[]).includes(command ?? '')) throw new Error(`用法：node scripts/debug-drive.ts <${COMMANDS.join('|')}> [--url <字串>]`);
  const port = Number(option('--port') ?? DEFAULT_PORT);
  const urlFilter = option('--url');
  if (!(await isListening(port))) throw new Error(`port ${port} 沒有開著的 Chrome；先跑 npm run debug:chrome`);

  const cdp = await connectCdp(port);
  try {
    const id = await extensionId(cdp);
    if (id === undefined) throw new Error('debug Chrome 裡還沒載入外掛：請使用者在 chrome://extensions 載入未封裝項目（只有第一次）');
    const origin = `chrome-extension://${id}`;

    // 用一個背景分頁當外掛 context（沒有 tabId 的 side panel 只會顯示提示），拿 chrome.tabs 與 chrome.windows。
    // 它送出的訊息也會叫醒閒置的 SW。
    const { targetId: helperId } = await cdp.send('Target.createTarget', { url: `${origin}/sidepanel.html`, background: true });
    try {
      const helper = await attachPage(cdp, helperId);
      // 剛開的分頁先是 about:blank，載入外掛頁面時 context 會換掉；載完才執行，否則會遇到 Execution context was destroyed
      const loaded = `location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`;
      if (!(await poll(async () => (await helper(loaded)) === true))) throw new Error('外掛頁面沒有載入');

      const { tabs, lastFocusedWindowId } = (await helper(`(async () => {
        const tabs = await chrome.tabs.query({});
        const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
        return { tabs: tabs.map((t) => ({ id: t.id, url: t.url || t.pendingUrl || '', active: t.active, windowId: t.windowId })), lastFocusedWindowId: focused?.id };
      })()`)) as { tabs: ChromeTab[]; lastFocusedWindowId?: number };
      const tab = pickMangaTab(tabs, lastFocusedWindowId, urlFilter);
      if (!tab) throw new Error(urlFilter === undefined ? '找不到網頁分頁：先在 debug Chrome 打開漫畫頁' : `找不到 url 含「${urlFilter}」的分頁`);
      console.error(`分頁 ${tab.id} → ${tab.url}`);

      const panelUrl = `${origin}/sidepanel.html?tabId=${tab.id}`;
      const findPanel = async () => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        return panelTarget(
          (targetInfos as { targetId: string; type: string; url: string }[]).map((t) => ({ id: t.targetId, type: t.type, url: t.url })),
          tab.id,
        );
      };
      if ((await findPanel()) === undefined) {
        await helper(`chrome.windows.create({ url: ${JSON.stringify(panelUrl)}, focused: false, ...${JSON.stringify(PANEL_WINDOW)} }).then(() => true)`);
        if (!(await poll(async () => (await findPanel()) !== undefined))) throw new Error('side panel 視窗沒有打開');
        console.log(`已開 side panel 視窗：${panelUrl}`);
      } else console.log(`沿用已開的 side panel 視窗：${panelUrl}`);

      if ((command as Command) === 'activate') {
        // SW 卡住時 sendMessage 永遠不會回來，不能讓指令跟著卡住
        const responded = await helper(`Promise.race([
          chrome.runtime.sendMessage({ type: 'test:activate', tabId: ${tab.id} }).then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), ${ACTIVATE_TIMEOUT_MS})),
        ])`);
        if (responded !== true) throw new Error(`SW ${ACTIVATE_TIMEOUT_MS / 1000} 秒內沒有完成啟動：看 debug:summary`);
        const panel = await attachPage(cdp, (await findPanel())!.id);
        const active = await poll(async () => (await panel("document.body.innerText.includes('已啟動')")) === true);
        console.log(active ? '已啟動（side panel 顯示「已啟動」）' : '已送出啟動，但 side panel 10 秒內沒有顯示「已啟動」：看 debug:summary');
        if (!active) process.exitCode = 1;
      }
    } finally {
      await cdp.send('Target.closeTarget', { targetId: helperId }).catch(() => {});
    }
  } finally {
    cdp.close();
  }
}

try {
  await main();
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
