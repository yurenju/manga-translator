import type { Message } from '../shared/messages.ts';

/**
 * 由 SW 以 scripting.executeScript 動態注入（沒有靜態 content_scripts）。
 * 跑在 isolated world：這裡的 globalThis 跟頁面的 window 分開，頁面看不到。
 */
declare global {
  var __mangaTranslator: { active: true } | undefined;
}

// 同一頁可能被注入多次（例如重新整理事件重複），只啟動一次。
if (!globalThis.__mangaTranslator) {
  globalThis.__mangaTranslator = { active: true };

  const onMessage = (message: Message) => {
    if (message.type !== 'content:stop') return;
    chrome.runtime.onMessage.removeListener(onMessage);
    globalThis.__mangaTranslator = undefined;
  };
  chrome.runtime.onMessage.addListener(onMessage);
}
