/** offscreen document 同時只能有一份；併發呼叫共用同一個建立中的 promise。 */
let creating: Promise<void> | undefined;

export async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (existing.length > 0) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      // 裁切截圖要用 canvas；之後的 OCR 等工作也在這份 document 裡。沒有更貼切的 reason，用 BLOBS。
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'Crop screenshots of manga pages',
    })
    .finally(() => {
      creating = undefined;
    });
  await creating;
}
