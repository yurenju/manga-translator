import {
  expect,
  isContentScriptInjected,
  openJumpPlus,
  openSidePanel,
  tabIdOf,
  test,
  testActivate,
} from './fixtures.ts';

/** 載入完成後給 SW 的 tabs.onUpdated 一點時間；用在「應該不會注入」的斷言。 */
const SETTLE_MS = 1000;

test('mock site 的 canvas 是 tainted（getImageData 會丟錯）', async ({ context, mockSite }) => {
  const page = await openJumpPlus(context, mockSite);

  const error = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    try {
      canvas.getContext('2d')!.getImageData(0, 0, 1, 1);
      return null;
    } catch (e) {
      return (e as DOMException).name;
    }
  });

  expect(error).toBe('SecurityError');
});

test('透過測試入口啟動後 side panel 顯示「已啟動」，content script 已注入', async ({
  context,
  sw,
  extensionId,
  mockSite,
}) => {
  await openJumpPlus(context, mockSite);
  const tabId = await tabIdOf(sw, mockSite.jumpPlusUrl);
  const panel = await openSidePanel(context, extensionId, tabId);
  await expect(panel.getByText('請點外掛圖示啟動')).toBeVisible();

  await testActivate(panel, tabId);

  await expect(panel.getByText('已啟動')).toBeVisible();
  expect(await isContentScriptInjected(sw, tabId)).toBe(true);
});

test('同 origin 重新整理後 content script 自動重新注入', async ({ context, sw, extensionId, mockSite }) => {
  const page = await openJumpPlus(context, mockSite);
  const tabId = await tabIdOf(sw, mockSite.jumpPlusUrl);
  const panel = await openSidePanel(context, extensionId, tabId);
  await testActivate(panel, tabId);

  await page.reload();

  await expect.poll(() => isContentScriptInjected(sw, tabId)).toBe(true);
  await expect(panel.getByText('已啟動')).toBeVisible();
});

test('按「停止」後清掉 content script，重新整理也不再注入', async ({ context, sw, extensionId, mockSite }) => {
  const page = await openJumpPlus(context, mockSite);
  const tabId = await tabIdOf(sw, mockSite.jumpPlusUrl);
  const panel = await openSidePanel(context, extensionId, tabId);
  await testActivate(panel, tabId);
  await expect(panel.getByText('已啟動')).toBeVisible();

  await panel.getByRole('button', { name: '停止' }).click();

  await expect(panel.getByText('請點外掛圖示啟動')).toBeVisible();
  await expect.poll(() => isContentScriptInjected(sw, tabId)).toBe(false);
  await page.reload();
  await page.waitForTimeout(SETTLE_MS);
  expect(await isContentScriptInjected(sw, tabId)).toBe(false);
});

test('換 origin 就停止', async ({ context, sw, extensionId, mockSite }) => {
  const page = await openJumpPlus(context, mockSite);
  const tabId = await tabIdOf(sw, mockSite.jumpPlusUrl);
  const panel = await openSidePanel(context, extensionId, tabId);
  await testActivate(panel, tabId);
  await expect(panel.getByText('已啟動')).toBeVisible();

  await page.goto(`${mockSite.imageOrigin}/p01-basic.png`);

  await expect(panel.getByText('請點外掛圖示啟動')).toBeVisible();
  await page.waitForTimeout(SETTLE_MS);
  expect(await isContentScriptInjected(sw, tabId)).toBe(false);
});

test('從 Chrome 內建 side panel 選單打開（沒有 tabId）只提示點外掛圖示', async ({ context, extensionId }) => {
  const panel = await openSidePanel(context, extensionId);

  await expect(panel.getByText('請點外掛圖示啟動')).toBeVisible();
  await expect(panel.getByRole('button', { name: '停止' })).toHaveCount(0);
});
