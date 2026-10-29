/**
 * #38：Series Notes 管理與過時提示。仿 Jump+ 的翻頁版，偵測＋OCR 是真的（wasm）；FakeTranslator 在 Balloon 裡
 * 看到「パン」（p01）、「霧島湊」（p02）就新增條目，條目已經在 Notes 裡就補空欄位、譯文不同就提建議。
 */
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { NotesSuggestion } from '../src/shared/series-notes.ts';
import type { PageTranslation } from '../src/shared/page-text.ts';
import type { Series } from '../src/shared/series.ts';
import type { NotesEntry } from '../src/shared/translator.ts';
import { activateOnJumpPlus, chooseFromPanelMenu, configuredServiceWorker, expect, launchWithExtension, openSidePanel, readStore, test } from './fixtures.ts';

const パン = { 原文: 'パン', 讀音: 'ぱん', 譯文: '麵包', 類別: '用語' };
const 霧島湊 = { 原文: '霧島湊', 讀音: 'きりしまみなと', 譯文: '霧島湊', 類別: '人名' };

// 陣列第二個元素是物件時，Playwright 會把它當成 [值, 選項]，所以要用 tuple 寫法
test.use({ viewport: null, fakeTranslator: true, fakeNotes: [[パン, 霧島湊], { scope: 'test' }] });

/** 第一次載入模型（從 mock site 下載＋wasm 編譯）加上一頁 OCR。 */
const FIRST_PAGE_TIMEOUT = 60_000;
/** 模型已載入後的一頁。 */
const PAGE_TIMEOUT = 30_000;

const statusLine = (panel: Page) => panel.getByRole('status', { name: '翻譯狀態' });
const staleHint = (panel: Page) => panel.getByRole('group', { name: '過時提示' });
const notesSection = (panel: Page) => panel.getByRole('region', { name: 'Series Notes' });

async function openNotes(panel: Page): Promise<void> {
  await chooseFromPanelMenu(panel, 'Series Notes');
  await expect(notesSection(panel)).toBeVisible();
}

/** 編輯一個條目：只改給的欄位。 */
async function editNote(panel: Page, 原文: string, fields: Record<string, string>): Promise<void> {
  const section = notesSection(panel);
  await section.getByRole('button', { name: `編輯 ${原文}` }).click();
  for (const [label, value] of Object.entries(fields)) await section.getByRole('textbox', { name: label, exact: true }).fill(value);
  await section.getByRole('button', { name: '儲存' }).click();
}

const entryOf = async (sw: Parameters<typeof readStore>[0], 原文: string) =>
  (await readStore<NotesEntry>(sw, 'seriesNotes')).find((e) => e.原文 === 原文);

/**
 * 快取記的是翻譯（①）送出時 Notes 裡的條目（ADR 0005），第 1 頁翻譯時パン還不在 Notes 裡。
 * 等背景整理（②）把パン寫進 Notes，再重新翻譯 p01，讓它的快取記下用到パン。
 */
async function retranslateWithパン(sw: Parameters<typeof readStore>[0], panel: Page): Promise<void> {
  await expect.poll(async () => (await entryOf(sw, 'パン'))?.譯文).toBe('麵包');
  await panel.getByRole('contentinfo', { name: '狀態列' }).getByRole('button', { name: '重新翻譯' }).click();
  await expect
    .poll(async () => (await readStore<PageTranslation>(sw, 'pageTranslations')).flatMap((t) => t.usedNotes.map((u) => u.原文)), { timeout: PAGE_TIMEOUT })
    .toEqual(['パン']);
}

test('編輯條目後變 locked：之後 LLM 只能提建議，接受建議後改成建議的譯文', async ({ context, sw, extensionId, mockSite }) => {
  test.setTimeout(FIRST_PAGE_TIMEOUT + 2 * PAGE_TIMEOUT);
  const { page, panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite, url: mockSite.jumpPlusPagedUrl });
  await expect(statusLine(panel)).toHaveText([/^已翻譯・/], { timeout: FIRST_PAGE_TIMEOUT });
  await retranslateWithパン(sw, panel);
  await openNotes(panel);
  await expect(notesSection(panel).getByRole('row', { name: /パン/ })).toContainText('麵包');

  await editNote(panel, 'パン', { 譯文: '胖', 讀音: '' });
  await expect.poll(() => entryOf(sw, 'パン')).toMatchObject({ 譯文: '胖', 讀音: '', locked: true });

  // 這頁用到パン：馬上出現過時提示；重新翻譯時 FakeTranslator 想補讀音、把譯文改回麵包
  await page.bringToFront();
  await staleHint(panel).getByRole('button', { name: '重新翻譯' }).click();
  const suggestion = notesSection(panel).getByRole('listitem').filter({ hasText: 'パン' });
  await expect(suggestion).toContainText('麵包', { timeout: PAGE_TIMEOUT });
  await expect(staleHint(panel)).toBeHidden();
  expect(await entryOf(sw, 'パン')).toMatchObject({ 譯文: '胖', 讀音: '', locked: true });

  await suggestion.getByRole('button', { name: '接受' }).click();
  await expect.poll(() => entryOf(sw, 'パン')).toMatchObject({ 譯文: '麵包', locked: true });
  await expect(suggestion).toBeHidden();
});

test('改了某頁用到的條目譯文，回到那頁出現過時提示；只新增條目不出現', async ({ context, sw, extensionId, mockSite }) => {
  test.setTimeout(FIRST_PAGE_TIMEOUT + 4 * PAGE_TIMEOUT);
  const { page, panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite, url: mockSite.jumpPlusPagedUrl });
  await expect(statusLine(panel)).toHaveText([/^已翻譯・/], { timeout: FIRST_PAGE_TIMEOUT });
  await retranslateWithパン(sw, panel);

  // p02 新增了霧島湊；回到 p01（快取）不算過時
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await entryOf(sw, '霧島湊'))?.譯文, { timeout: PAGE_TIMEOUT }).toBe('霧島湊');
  await expect(statusLine(panel)).toHaveText([/^已翻譯・/], { timeout: PAGE_TIMEOUT });
  await page.keyboard.press('ArrowRight');
  await expect(statusLine(panel)).toHaveText([/^快取・/], { timeout: PAGE_TIMEOUT });
  await expect(staleHint(panel)).toBeHidden();

  // 在 p02 改パン（p02 沒用到它）
  await page.keyboard.press('ArrowLeft');
  await expect(statusLine(panel)).toHaveText([/^快取・/], { timeout: PAGE_TIMEOUT });
  await openNotes(panel);
  await editNote(panel, 'パン', { 譯文: '胖' });
  await expect.poll(() => entryOf(sw, 'パン')).toMatchObject({ 譯文: '胖' });
  await expect(staleHint(panel)).toBeHidden();

  await page.bringToFront();
  await page.keyboard.press('ArrowRight');
  await expect(staleHint(panel)).toContainText('Series Notes 已更新', { timeout: PAGE_TIMEOUT });
  await expect(panel.getByRole('contentinfo', { name: '狀態列' })).toContainText('Series Notes 已更新');
});

test('匯出再匯入到乾淨的 profile：Notes 與快取一致，匯出檔沒有 API key', async ({ context, sw, extensionId, mockSite }) => {
  test.setTimeout(FIRST_PAGE_TIMEOUT * 2);
  const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite, url: mockSite.jumpPlusPagedUrl });
  await expect(statusLine(panel)).toHaveText([/^已翻譯・/], { timeout: FIRST_PAGE_TIMEOUT });
  // Notes 在背景整理（ADR 0005）：寫進去之後再匯出
  await expect.poll(async () => (await entryOf(sw, 'パン'))?.譯文).toBe('麵包');
  const API_KEY = 'sk-ant-e2e-export-must-not-contain-this-key';
  await chooseFromPanelMenu(panel, 'API key 與模型');
  await panel.getByLabel('Claude API key').fill(API_KEY);
  await panel.getByRole('button', { name: '儲存' }).click();
  await expect(panel.getByText(/末四碼/)).toBeVisible();

  const downloading = panel.waitForEvent('download');
  await panel.getByRole('button', { name: '匯出 JSON' }).click();
  const file = await (await downloading).path();
  const exported = await readFile(file, 'utf8');
  expect(exported).not.toContain(API_KEY);

  const clean = await launchWithExtension('');
  try {
    const cleanSw = await configuredServiceWorker(clean, mockSite);
    const cleanPanel = await openSidePanel(clean, new URL(cleanSw.url()).host);
    await chooseFromPanelMenu(cleanPanel, 'API key 與模型');
    await cleanPanel.getByLabel('匯入 JSON').setInputFiles(file);
    await expect(cleanPanel.getByText('匯入完成')).toBeVisible();

    const sorted = <T>(rows: T[]) => rows.map((r) => JSON.stringify(r)).sort();
    for (const store of ['series', 'urlPatterns', 'seriesNotes', 'notesSuggestions', 'pageTranslations']) {
      expect(sorted(await readStore(cleanSw, store)), store).toEqual(sorted(await readStore(sw, store)));
    }
    expect(await readStore<NotesEntry>(cleanSw, 'seriesNotes')).toEqual([expect.objectContaining({ 原文: 'パン', 譯文: '麵包' })]);
    expect(await readStore<PageTranslation>(cleanSw, 'pageTranslations')).toHaveLength(1);
    expect(await readStore<Series>(cleanSw, 'series')).toHaveLength(1);
    expect(await readStore<NotesSuggestion>(cleanSw, 'notesSuggestions')).toEqual([]);
    expect(await readStore(cleanSw, 'apiKeys')).toEqual([]);
  } finally {
    await clean.close();
  }
});
