import type { Message, PageCandidate, PageCandidatesResponse, Rect } from '../shared/messages.ts';
import { createTrace } from '../shared/trace.ts';
import { createOverlay, HOST_ATTRIBUTE } from './overlay.ts';
import { createOverlayFontLoader } from './overlay-font.ts';
import { occludersOf } from './occlusion.ts';
import { pageCandidateRejection } from './page-candidates.ts';
import { watchPageTurns } from './page-turn.ts';

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
  const trace = createTrace('content');

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
    /** 除錯記錄用：夠大但不算候選的元素（太小的只算數量，圖示太多）。 */
    const rejected: { tag: string; rect: Rect; reason: string; clips: Rect[] }[] = [];
    let small = 0;
    let occluded = 0;
    anchors.clear();
    for (const element of document.querySelectorAll('img, canvas')) {
      const box = element.getBoundingClientRect();
      const { x, y, width, height } = box;
      const rect = { x, y, width, height };
      const clips = clipRects(element);
      let reason: string | undefined = pageCandidateRejection(rect, visible, clips);
      // 被工具列之類蓋住的不算完整可見，等它收起再截（#55、ADR 0004）。工具列收起時也會再掃：
      // 沒有任何 anchor 時 relatesToPage 一律回 true，工具列本身的變動（淡出後 display: none）就會觸發。
      if (reason === undefined) {
        const occluders = occludersOf(element, box, (el) => el.closest(`[${HOST_ATTRIBUTE}]`) !== null);
        if (occluders.length > 0) {
          reason = 'occluded';
          occluded++;
          if (__DEBUG__) trace('occluded', { tag: element.tagName.toLowerCase(), rect, occluders: occluders.slice(0, 5).map(describe) });
        }
      }
      if (reason === undefined) {
        const overlaid = overlay.shownPages(element);
        candidates.push({ anchorId: anchorIdOf(element), rect, ...(overlaid.length > 0 ? { overlaid } : {}) });
      }
      else if (__DEBUG__ && reason === 'small') small++;
      else if (__DEBUG__) rejected.push({ tag: element.tagName.toLowerCase(), rect, reason, clips });
    }
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    if (__DEBUG__) trace('candidates', { url: location.href, viewport, visible, dpr: devicePixelRatio, candidates, rejected, small, occluded });
    return { viewport, candidates, ...(occluded > 0 ? { occluded } : {}) };
  }

  /** trace 用：tag#id.class。 */
  function describe(element: Element): string {
    const cls = typeof element.className === 'string' ? element.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${cls ? `.${cls}` : ''}`;
  }

  /** 會裁切內容的祖先（overflow 不是 visible）：翻頁式 viewer 的隔壁頁在它外面。 */
  function clipRects(element: Element): Rect[] {
    const clips: Rect[] = [];
    for (let el = element.parentElement; el && el !== document.documentElement && el !== document.body; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const { x, y, width, height } = el.getBoundingClientRect();
      clips.push({ x, y, width, height });
    }
    return clips;
  }

  const overlay = createOverlay({
    loadFont: createOverlayFontLoader(),
    // 頁面 hover → side panel 高亮那行（panel 用 sender.tab 分辨是哪個 tab）
    onHover(line) {
      chrome.runtime.sendMessage({ type: 'content:hover', line } satisfies Message).catch(() => {});
    },
  });

  // 翻頁訊號 → SW 截圖比對 hash（#34）。SW 停止或重新載入時送不到，忽略。
  // 覆蓋層改過 position 的父元素，之後它的 style 變動一律當成自己的（頁面改它的 style 會漏掉，接受）
  const isOwn = (node: Node, attribute?: string) =>
    node instanceof Element && (node.closest(`[${HOST_ATTRIBUTE}]`) !== null || (attribute === 'style' && overlay.ownsStyleOf(node)));
  // 還沒量到任何 Page（剛啟動、上次沒有完整可見的 Page）時一律算，免得漏掉第一頁
  const relatesToPage = (node: Node, added: boolean) => {
    if (anchors.size === 0) return true;
    for (const anchor of anchors.values()) if (node.contains(anchor) || anchor.contains(node)) return true;
    return added && node instanceof Element && (node.matches('img, canvas') || node.querySelector('img, canvas') !== null);
  };
  const stopWatching = watchPageTurns({
    notify(reasons) {
      trace('pageTurn', { reasons });
      chrome.runtime.sendMessage({ type: 'content:pageTurn' } satisfies Message).catch(() => {});
    },
    isOwn,
    relatesToPage,
    document,
    window,
    MutationObserver,
  });

  const onMessage = (message: Message, _sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void): boolean => {
    switch (message.type) {
      case 'content:findPageCandidates':
        sendResponse(findPageCandidates());
        return false;
      case 'content:showOverlay': {
        // anchor 不在最近一次量到的 Page 裡（已經捲走或換頁）就不覆蓋
        const anchor = anchors.get(message.anchorId);
        overlay.setEnabled(message.enabled);
        if (anchor instanceof HTMLElement)
          overlay
            .show(anchor, message.subRect, message.text, message.pageHash)
            .then(() => chrome.runtime.sendMessage({ type: 'content:overlayShown' } satisfies Message))
            .catch((e: unknown) => console.warn('overlay failed', e));
        else trace('overlay:skip', { anchorId: message.anchorId, pageHash: message.pageHash, reason: 'anchor 不在最近一次量到的 Page 裡' });
        return false;
      }
      case 'content:hideOverlay':
        void overlay.hideForCapture().then(() => sendResponse(null));
        return true;
      case 'content:restoreOverlay': {
        const hiddenMs = overlay.restoreAfterCapture();
        trace('overlay:restore', { hiddenMs });
        if (__E2E__ && hiddenMs !== undefined) (globalThis.__overlayHiddenMs ??= []).push(hiddenMs);
        sendResponse(null);
        return false;
      }
      case 'content:highlight':
        overlay.highlight(message.line);
        return false;
      case 'content:setOverlayEnabled':
        overlay.setEnabled(message.enabled);
        return false;
      case 'content:stop':
        chrome.runtime.onMessage.removeListener(onMessage);
        stopWatching();
        overlay.clear();
        anchors.clear();
        globalThis.__mangaTranslator = undefined;
        // 停止後頁面要跟沒裝外掛時一樣（#40 驗收 I1）
        trace('content:stop', { overlaysLeft: document.querySelectorAll(`[${HOST_ATTRIBUTE}]`).length });
        return false;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(onMessage);
}
