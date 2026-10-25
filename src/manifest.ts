/**
 * 權限照 spec #27 第 6 節：沒有 host_permissions、沒有靜態 content_scripts，
 * 也不用 openPanelOnActionClick（ADR 0003）。e2e build 額外宣告 <all_urls>（第 12 節）。
 *
 * 與 ADR 0003 的差異：ADR 只列 activeTab＋scripting＋sidePanel，這裡多了 offscreen（ADR 0001）
 * 與 unlimitedStorage（ADR 0002）。spec #27 第 13 節第 6 項決定以合併後的清單為準。
 */
export function buildManifest({ e2e }: { e2e: boolean }): chrome.runtime.ManifestV3 {
  return {
    manifest_version: 3,
    name: e2e ? 'Manga Translator (e2e)' : 'Manga Translator',
    version: '0.1.0',
    description: '把畫面上的日文漫畫原地翻成繁體中文',
    minimum_chrome_version: '116',
    permissions: ['activeTab', 'scripting', 'sidePanel', 'offscreen', 'unlimitedStorage'],
    ...(e2e ? { host_permissions: ['<all_urls>'] } : {}),
    background: { service_worker: 'background.js', type: 'module' },
    action: { default_title: '漫畫翻譯：在這個分頁啟動' },
    side_panel: { default_path: 'sidepanel.html' },
    commands: {
      activate: {
        suggested_key: { default: 'Alt+Shift+M' },
        description: '在這個分頁啟動漫畫翻譯',
      },
    },
  };
}
