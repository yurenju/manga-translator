import { describe, expect, it } from 'vitest';
import { buildExpression, candidateTargets, isOurExtension, panelTarget, pickMangaTab, type ChromeTab, type TargetInfo } from './debug-targets.ts';

const target = (type: string, url: string): TargetInfo => ({ id: url, type, url, webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/${type}/${url}` });

const ours = 'chrome-extension://aaaa';
const other = 'chrome-extension://bbbb';
const list: TargetInfo[] = [
  target('page', 'https://shonenjumpplus.com/episode/1'),
  target('service_worker', `${other}/background.js`),
  target('service_worker', `${ours}/background.js`),
  target('other', `${ours}/offscreen.html`),
  target('page', 'chrome://extensions/'),
  target('page', `${ours}/sidepanel.html`),
  target('service_worker', 'https://shonenjumpplus.com/sw.js'),
  target('page', 'https://example.com/'),
  { id: 'no-ws', type: 'page', url: 'https://attached-elsewhere.com/' },
];

describe('candidateTargets', () => {
  it('sw：每個外掛的 service worker（同名 background.js 也都列，之後用 manifest 名稱挑），網站自己的 SW 不算', () => {
    expect(candidateTargets(list, 'sw').map((t) => t.url)).toEqual([`${other}/background.js`, `${ours}/background.js`]);
  });

  it('offscreen：外掛的 offscreen.html，不管 target type', () => {
    expect(candidateTargets(list, 'offscreen').map((t) => t.url)).toEqual([`${ours}/offscreen.html`]);
  });

  it('page／content：一般網頁分頁，照 /json/list 的順序；沒有 WebSocket 的不列', () => {
    expect(candidateTargets(list, 'page').map((t) => t.url)).toEqual(['https://shonenjumpplus.com/episode/1', 'https://example.com/']);
    expect(candidateTargets(list, 'content')).toEqual(candidateTargets(list, 'page'));
  });

  it('url 篩選只套在分頁上', () => {
    expect(candidateTargets(list, 'page', 'example').map((t) => t.url)).toEqual(['https://example.com/']);
    expect(candidateTargets(list, 'sw', 'example')).toHaveLength(2);
  });
});

describe('isOurExtension', () => {
  it('debug 與正式版都算，別的外掛不算', () => {
    expect(isOurExtension('Naruhodo (debug)')).toBe(true);
    expect(isOurExtension('Naruhodo')).toBe(true);
    expect(isOurExtension('Google Docs Offline')).toBe(false);
    expect(isOurExtension(undefined)).toBe(false);
  });
});

describe('buildExpression', () => {
  const run = (expression: string) => (0, eval)(expression) as Promise<unknown>;

  it('包成 async IIFE，運算式裡可以 await，結尾分號拿掉', async () => {
    await expect(run(buildExpression('await Promise.resolve(1) + 1;\n', 'page'))).resolves.toBe(2);
  });

  it('最後一行是註解也沒關係', async () => {
    await expect(run(buildExpression('[1, 2].length // 兩頁', 'offscreen'))).resolves.toBe(2);
  });

  it('只有 SW 有 activeTab()', () => {
    expect(buildExpression('1', 'sw')).toContain('const activeTab = async () =>');
    expect(buildExpression('1', 'page')).not.toContain('activeTab');
  });

  it('沒有程式就報錯', () => {
    expect(() => buildExpression(' ;\n', 'sw')).toThrow('沒有要執行的程式');
  });
});

describe('pickMangaTab', () => {
  const tabs: ChromeTab[] = [
    { id: 1, url: 'https://example.com/', active: true, windowId: 10 },
    { id: 2, url: 'https://shonenjumpplus.com/episode/1', active: false, windowId: 20 },
    { id: 3, url: 'https://read.amazon.co.jp/manga/X', active: true, windowId: 20 },
    { id: 4, url: 'chrome://extensions/', active: true, windowId: 30 },
  ];

  it('沒給 url：最後聚焦視窗的作用中分頁', () => {
    expect(pickMangaTab(tabs, 20)?.id).toBe(3);
  });

  it('最後聚焦的是 side panel 視窗之類沒有網頁的視窗：只有一個作用中網頁分頁時才退回用它', () => {
    const single = tabs.filter((tab) => tab.id !== 3);
    expect(pickMangaTab(single, 30)?.id).toBe(1);
    expect(pickMangaTab(single, undefined)?.id).toBe(1);
  });

  it('退回時有好幾個視窗的作用中網頁分頁：不猜，回傳 undefined（要給 url）', () => {
    expect(pickMangaTab(tabs, 30)).toBeUndefined();
  });

  it('給了 url：第一個 url 含這段字的網頁分頁，不管是不是作用中', () => {
    expect(pickMangaTab(tabs, 20, 'jumpplus')?.id).toBe(2);
    expect(pickMangaTab(tabs, 20, 'extensions')).toBeUndefined();
  });

  it('沒有網頁分頁就回傳 undefined', () => {
    expect(pickMangaTab([tabs[3]!], 30)).toBeUndefined();
  });
});

describe('panelTarget', () => {
  it('挑出這個分頁專屬的 side panel（sidepanel.html?tabId=N）', () => {
    const panels = [target('page', `${ours}/sidepanel.html?tabId=12`), target('page', `${ours}/sidepanel.html?tabId=3`), target('page', `${ours}/sidepanel.html`)];
    expect(panelTarget(panels, ours, 3)?.url).toBe(`${ours}/sidepanel.html?tabId=3`);
    expect(panelTarget(panels, ours, 1)).toBeUndefined();
  });

  it('只認這個外掛的：別的外掛或網站的同名頁面不算', () => {
    expect(panelTarget([target('page', `${other}/sidepanel.html?tabId=3`)], ours, 3)).toBeUndefined();
    expect(panelTarget([target('page', 'https://example.com/sidepanel.html?tabId=3')], ours, 3)).toBeUndefined();
  });
});
