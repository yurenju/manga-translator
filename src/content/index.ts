import type { Message, PageCandidate, PageCandidatesResponse } from '../shared/messages.ts';
import { createOverlay } from './overlay.ts';
import { createOverlayFontLoader } from './overlay-font.ts';
import { isPageCandidate } from './page-candidates.ts';

/**
 * 由 SW 以 scripting.executeScript 動態注入（沒有靜態 content_scripts）。
 * 跑在 isolated world：這裡的 globalThis 跟頁面的 window 分開，頁面看不到。
 */
declare global {
  var __mangaTranslator: { active: true } | undefined;
  /** e2e build 才有：每次截圖時覆蓋層被藏了多久（ms），給測試量閃爍時間。 */
  var __overlayHiddenMs: number[] | undefined;
}

// 同一頁可能被注入多次（例如重新整理事件重複），只啟動一次。
if (!globalThis.__mangaTranslator) {
  globalThis.__mangaTranslator = { active: true };

  /**
   * anchor：最近一次量到的 Page 候選元素，之後的覆蓋層靠 id 找回元素。每次重量就重建，
   * 翻頁後被拿掉的元素才不會一直留著。同一個元素一直用同一個 id（WeakMap 不擋回收）。
   */
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

  function findPageCandidates(): PageCandidatesResponse {
    // 完整可見用 clientWidth/Height（不含捲軸）判斷；換算截圖倍率用 innerWidth/Height，
    // 因為 captureVisibleTab 截的是含捲軸的整個可視區域。
    const visible = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    const candidates: PageCandidate[] = [];
    anchors.clear();
    for (const element of document.querySelectorAll('img, canvas')) {
      const { x, y, width, height } = element.getBoundingClientRect();
      const rect = { x, y, width, height };
      if (isPageCandidate(rect, visible)) candidates.push({ anchorId: anchorIdOf(element), rect });
    }
    return { viewport: { width: window.innerWidth, height: window.innerHeight }, candidates };
  }

  const overlay = createOverlay({ loadFont: createOverlayFontLoader() });

  const onMessage = (message: Message, _sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void): boolean => {
    switch (message.type) {
      case 'content:findPageCandidates':
        sendResponse(findPageCandidates());
        return false;
      case 'content:showOverlay': {
        // anchor 不在最近一次量到的 Page 裡（已經捲走或換頁）就不覆蓋
        const anchor = anchors.get(message.anchorId);
        overlay.setEnabled(message.enabled);
        if (anchor instanceof HTMLElement) overlay.show(anchor, message.sub, message.text).catch((e: unknown) => console.warn('overlay failed', e));
        return false;
      }
      case 'content:hideOverlay':
        void overlay.hideForCapture().then(() => sendResponse(null));
        return true;
      case 'content:restoreOverlay': {
        const hiddenMs = overlay.restoreAfterCapture();
        if (__E2E__ && hiddenMs !== undefined) (globalThis.__overlayHiddenMs ??= []).push(hiddenMs);
        sendResponse(null);
        return false;
      }
      case 'content:setOverlayEnabled':
        overlay.setEnabled(message.enabled);
        return false;
      case 'content:stop':
        chrome.runtime.onMessage.removeListener(onMessage);
        overlay.clear();
        anchors.clear();
        globalThis.__mangaTranslator = undefined;
        return false;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(onMessage);
}
