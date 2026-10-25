import type { Message, PageCandidate, PageCandidatesResponse } from '../shared/messages.ts';
import { isPageCandidate } from './page-candidates.ts';

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

  /** anchor：Page 候選的元素。同一個元素一直用同一個 id，之後的覆蓋層靠 id 找回元素。 */
  const anchors = new Map<string, Element>();
  const anchorIds = new WeakMap<Element, string>();
  let nextAnchorId = 1;

  function anchorIdOf(element: Element): string {
    let id = anchorIds.get(element);
    if (id === undefined) {
      id = `a${nextAnchorId++}`;
      anchorIds.set(element, id);
    }
    anchors.set(id, element);
    return id;
  }

  function findPages(): PageCandidatesResponse {
    // 完整可見用 clientWidth/Height（不含捲軸）判斷；換算截圖倍率用 innerWidth/Height，
    // 因為 captureVisibleTab 截的是含捲軸的整個可視區域。
    const visible = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    const candidates: PageCandidate[] = [];
    for (const element of document.querySelectorAll('img, canvas')) {
      const { x, y, width, height } = element.getBoundingClientRect();
      const rect = { x, y, width, height };
      if (isPageCandidate(rect, visible)) candidates.push({ anchorId: anchorIdOf(element), rect });
    }
    return { viewport: { width: window.innerWidth, height: window.innerHeight }, candidates };
  }

  const onMessage = (message: Message, _sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
    switch (message.type) {
      case 'content:findPages':
        sendResponse(findPages());
        return;
      case 'content:stop':
        chrome.runtime.onMessage.removeListener(onMessage);
        anchors.clear();
        globalThis.__mangaTranslator = undefined;
        return;
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);
}
