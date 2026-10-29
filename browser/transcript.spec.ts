/**
 * #30：本機偵測＋OCR → side panel 逐字稿。OCR 用 FakeEngine 重播（ADR 0007）；只對真模型有意義的（模型下載、
 * SHA-256 檢查）標 @e2e、在 browser test 跳過，e2e 從 mock site 下載模型（內容是 repo 外的模型快取）、強制 wasm。
 * 仿 Jump+ 的頁面顯示寬 430 px，截圖裡的 Page 只有原圖約一半大，重播的是真模型在這種截圖上的結果，
 * 所以這裡用相似度把每一行對回 ground truth，而不是要求逐字相同。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { Message, ModelStatus, ModelStatusResponse } from '../src/shared/messages.ts';
import { readGroundTruth, type GtText } from '../src/testing/synthetic.ts';
import {
  activateOnJumpPlus,
  configuredServiceWorker,
  expect,
  launchWithExtension,
  test,
} from './fixtures.ts';
import { startMockSite } from './mock-site/server.ts';

/** 跟 pages.spec.ts 一樣用真的視窗：截圖與 rect 才對得上。第 1、2 頁完整可見。 */
test.use({ viewport: null });

const normalize = (s: string) => s.normalize('NFKC').replace(/\s/g, '');

function similarity(a: string, b: string): number {
  const x = [...normalize(a)];
  const y = [...normalize(b)];
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length]! / Math.max(x.length, y.length, 1);
}

/** 每一行的原文最像哪一句 ground truth。 */
function matchGroundTruth(originals: string[], texts: GtText[]): (GtText | undefined)[] {
  return originals.map((o) => {
    const best = texts.map((t) => ({ t, s: similarity(o, t.ja) })).sort((a, b) => b.s - a.s)[0];
    return best && best.s >= 0.5 ? best.t : undefined;
  });
}

const transcriptOf = (panel: Page, pageIndex: number): Locator =>
  panel.getByRole('list', { name: 'Page' }).getByRole('listitem', { name: `第 ${pageIndex + 1} 頁` }).getByRole('list', { name: '逐字稿' });

async function lines(transcript: Locator) {
  return transcript.getByRole('listitem').evaluateAll((items) =>
    items.map((li) => {
      // 預設層級「加振り仮名」：原文（lang="ja"）帶 <rt>，對不上時下面是整句讀音（<small>）
      const shown = li.querySelector('[lang="ja"]')!;
      const original = shown.cloneNode(true) as Element;
      const rts = [...original.querySelectorAll('rt, small')].map((rt) => (rt.remove(), rt.textContent ?? ''));
      const badges = [...li.querySelectorAll('span')].filter((s) => s.children.length === 0).map((s) => s.textContent);
      return {
        loose: badges.includes('框外文字'),
        original: original.textContent ?? '',
        hasKanji: /[一-鿿々〆ヶ]/.test(original.textContent ?? ''),
        reading: rts.join(''),
        translation: li.querySelector('[lang="zh-Hant"]')?.textContent ?? null,
        untranslated: badges.includes('未翻譯') ? '未翻譯' : null,
        italic: getComputedStyle(shown).fontStyle === 'italic',
      };
    }),
  );
}

test.describe('沒有 API key', () => {
  test('side panel 依閱讀順序顯示原文＋讀音＋「未翻譯」，Loose Text 標「框外文字」',async ({ context, sw, extensionId, mockSite }) => {
    const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });

    const first = transcriptOf(panel, 0);
    await expect(first.getByRole('listitem').first()).toBeVisible();
    const p01 = await lines(first);
    const p01Gt = readGroundTruth('p01-basic').texts;
    const matched = matchGroundTruth(p01.map((l) => l.original), p01Gt);
    console.log('p01 逐字稿', p01.map((l, i) => `${l.original}（${l.reading}）→ ${matched[i]?.id ?? '?'}`).join(' / '));
    // 7 句裡至少 6 句認得出來，而且依 ground truth 的閱讀順序排列
    const orders = matched.filter((t) => t !== undefined).map((t) => t.order);
    expect(orders.length).toBeGreaterThanOrEqual(6);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    for (const line of p01) {
      if (line.hasKanji) expect(line.reading).not.toBe('');
      expect(line.untranslated).toBe('未翻譯');
      expect(line.translation).toBeNull();
    }
    await expect(panel.getByText('尚未設定 API key')).toBeVisible();

    // p02 的旁白「潮見坂高校 4月12日」在 Balloon 外，是 Loose Text
    const second = transcriptOf(panel, 1);
    await expect(second.getByRole('listitem').first()).toBeVisible();
    const p02 = await lines(second);
    console.log('p02 逐字稿', p02.map((l) => `[${l.loose ? '框外文字' : 'balloon'}] ${l.original}`).join(' / '));
    const narration = p02.find((l) => similarity(l.original, '潮見坂高校4月12日') >= 0.5);
    expect(narration?.loose).toBe(true);
    expect(p02.some((l) => !l.loose)).toBe(true);
    // 「框外文字」徽章取代原本的斜體＋🔊
    for (const line of p02) {
      expect(line.original).not.toContain('🔊');
      expect(line.italic).toBe(false);
    }
  });
});

test.describe('FakeTranslator', () => {
  test.use({ fakeTranslator: true });

  test('side panel 顯示譯文', async ({ context, sw, extensionId, mockSite }) => {
    const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });

    const first = transcriptOf(panel, 0);
    await expect(first.getByText('早安！今天好早喔')).toBeVisible();
    const p01 = await lines(first);
    console.log('p01 譯文', p01.map((l) => `${l.original} → ${l.translation}（${l.reading}）`).join(' / '));
    const zh = new Set(readGroundTruth('p01-basic').texts.map((t) => t.zh));
    expect(p01.filter((l) => l.translation !== null && zh.has(l.translation)).length).toBeGreaterThanOrEqual(6);
    expect(p01.every((l) => l.untranslated === null)).toBe(true);
    // 讀音換成 Translator 的（ground truth 的整句讀音「おはよう！きょうははやいね」對齊回漢字）
    expect(p01.map((l) => l.reading)).toContain('きょうはや');
  });
});

test('模型 SHA-256 不符時不使用並顯示錯誤；修好後按重試就能用', { tag: '@e2e' }, async ({ context, sw, extensionId, mockSite, fakeOcr }) => {
  test.skip(fakeOcr, '需要真的模型，只在 e2e 跑');
  mockSite.corruptModel('onnx/decoder_model_quantized.onnx');
  const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });

  await expect(panel.getByRole('alert')).toContainText('SHA-256 不符');
  await expect(panel.getByRole('alert')).toContainText('decoder_model_quantized.onnx');
  await expect(panel.getByText('辨識失敗').first()).toBeVisible();
  await expect(panel.getByRole('list', { name: '逐字稿' })).toHaveCount(0);

  mockSite.repairModels();
  // 重試會重新擷取：仿 Jump+ 維持在前景（跟真的 side panel 一樣），才截得到它
  await panel.getByRole('button', { name: '重試' }).click();
  await expect(transcriptOf(panel, 0).getByRole('listitem').first()).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('第一次使用時下載模型並顯示進度與大小；重開瀏覽器後不再下載', { tag: '@e2e' }, async ({ fakeOcr }) => {
  test.skip(fakeOcr, '需要真的模型，只在 e2e 跑');
  const userDataDir = await mkdtemp(join(tmpdir(), 'manga-profile-'));
  const site = await startMockSite();
  try {
    // 第一次：下載
    let context = await launchWithExtension(userDataDir);
    let sw = await configuredServiceWorker(context, site);
    let extensionId = new URL(sw.url()).host;
    const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite: site, beforeActivate: recordModelStatus });
    await expect(transcriptOf(panel, 0).getByRole('listitem').first()).toBeVisible();
    const firstRequests = site.modelRequests.length;
    expect(firstRequests).toBe(4); // detector、encoder、decoder、vocab
    const statuses = await panel.evaluate(() => (globalThis as unknown as { __statuses: ModelStatus[] }).__statuses);
    const downloading = statuses.filter((s) => s.state === 'downloading');
    expect(downloading[0]).toEqual({ state: 'downloading', loaded: 0, total: 127_740_540 });
    expect(downloading.at(-1)).toEqual({ state: 'downloading', loaded: 127_740_540, total: 127_740_540 });
    const ready = await panel.evaluate(
      async (message) => (await chrome.runtime.sendMessage<Message, ModelStatusResponse>(message)).status,
      { type: 'panel:getModelStatus' } satisfies Message,
    );
    console.log('offscreen 的模型狀態', JSON.stringify(ready));
    // manifest 的 COOP／COEP 讓 offscreen document crossOriginIsolated，wasm 才會多執行緒
    expect(ready).toMatchObject({ state: 'ready', executionProvider: 'wasm' });
    expect(ready.state === 'ready' && ready.threads).toBeGreaterThan(1);
    await context.close();

    // 第二次：同一個設定檔，從 Cache Storage 載入
    context = await launchWithExtension(userDataDir);
    sw = await configuredServiceWorker(context, site);
    extensionId = new URL(sw.url()).host;
    const second = await activateOnJumpPlus({ context, sw, extensionId, mockSite: site });
    await expect(transcriptOf(second.panel, 0).getByRole('listitem').first()).toBeVisible();
    expect(site.modelRequests.length).toBe(firstRequests);
    await context.close();
  } finally {
    await site.close();
    // Windows 上瀏覽器剛關時 lockfile 可能還被占用
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
});

/** 在 side panel 裡記下所有 models:status（本機下載很快，畫面上的進度一閃而過）。 */
async function recordModelStatus(panel: Page): Promise<void> {
  await panel.evaluate(() => {
    const g = globalThis as unknown as { __statuses: ModelStatus[] };
    g.__statuses = [];
    chrome.runtime.onMessage.addListener((m: Message) => {
      if (m.type === 'models:status') g.__statuses.push(m.status);
    });
  });
}
