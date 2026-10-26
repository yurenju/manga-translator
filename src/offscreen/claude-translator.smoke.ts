/**
 * 第 4 層（spec #27 第 12 節）：對一張合成頁（p01）呼叫真的 Claude API，記錄延遲、token、費用，
 * 並確認第二次呼叫吃到 prompt cache（usage.cache_read_input_tokens > 0）。
 * `npm run smoke` 才會跑；沒有 key 時跳過並印出「已跳過」（不能算通過）。key 不印出。
 */
import { describe, expect, it } from 'vitest';
import type { NotesEntry, TranslateInput } from '../shared/translator.ts';
import { readGroundTruth } from '../testing/synthetic.ts';
import { readTestApiKey, TEST_API_KEY_FILE } from '../testing/test-api-key.ts';
import { CLAUDE_MODEL, createClaudeTranslator, type ApiUsage } from './claude-translator.ts';

const apiKey = readTestApiKey();
if (!apiKey) console.log(`已跳過：沒有 MANGA_TRANSLATOR_ANTHROPIC_KEY，也沒有 ${TEST_API_KEY_FILE}`);

const gt = readGroundTruth('p01-basic');
const page: TranslateInput['items'] = gt.texts
  .sort((a, b) => a.order - b.order)
  .map((t, i) => ({ id: `t${i + 1}`, kind: t.kind === 'balloon' ? 'balloon' : 'loose', 原文: t.ja, orientation: t.orientation }));

/** 模擬累積了一些條目的 Series Notes（#37 之後才會真的累積）；跟 p01 無關也沒關係，重點是每頁逐字相同。 */
const notes: NotesEntry[] = [
  ['霧島湊', 'きりしまみなと', '霧島湊', '人名'],
  ['ミオ', 'みお', '美緒', '人名'],
  ['潮見坂高校', 'しおみざかこうこう', '潮見坂高中', '地名'],
  ['ひだまりベーカリー', 'ひだまりべーかりー', '向陽麵包店', '地名'],
  ['相棒', 'あいぼう', '搭檔', '用語'],
].map(([原文, 讀音, 譯文, 類別]) => ({ seriesId: 'smoke', 原文: 原文!, 讀音: 讀音!, 譯文: 譯文!, 類別: 類別!, locked: false }));

describe.skipIf(!apiKey)('真的 Claude API（smoke）', () => {
  it('合成頁 p01：回傳每一句的讀音與譯文；第二次呼叫吃到 prompt cache', { timeout: 120_000 }, async () => {
    const usages: ApiUsage[] = [];
    const translator = createClaudeTranslator({
      apiKey: apiKey!,
      async fetch(url, init) {
        const response = await fetch(url, init);
        if (response.ok) usages.push(((await response.clone().json()) as { usage: ApiUsage }).usage);
        return response;
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => performance.now(),
    });

    const first = await translator.translatePage({ seriesNotes: notes, items: page });
    const second = await translator.translatePage({ seriesNotes: notes, items: page });

    for (const [i, output] of [first, second].entries()) {
      const u = usages[i]!;
      console.log(
        `第 ${i + 1} 次：${output.model}、${(output.latencyMs / 1000).toFixed(2)} s、` +
          `input ${u.input_tokens}＋cache write ${u.cache_creation_input_tokens ?? 0}＋cache read ${u.cache_read_input_tokens ?? 0}、` +
          `output ${u.output_tokens}、$${output.usage.costUsd.toFixed(6)}`,
      );
    }
    console.log(first.items.map((item, i) => `${page[i]!.原文}（${item.讀音}）→ ${item.譯文}${item.unreadable ? ' [unreadable]' : ''}`).join('\n'));
    console.log('notes_changes', JSON.stringify(first.notes_changes));

    expect(first.model).toBe(CLAUDE_MODEL);
    expect(first.items.map((i) => i.id)).toEqual(page.map((i) => i.id));
    for (const item of first.items) {
      expect(item.unreadable).toBe(false);
      expect(item.譯文).not.toBe('');
      expect(item.讀音).not.toBe('');
    }
    expect(first.usage.costUsd).toBeGreaterThan(0);
    expect(first.usage.costUsd).toBeLessThan(0.01);
    // Haiku 5.5 最小可快取前綴 512 tokens；system（指示＋Notes）在第二次應該整段 cache read
    expect(usages[0]!.cache_creation_input_tokens! + usages[0]!.cache_read_input_tokens!).toBeGreaterThan(0);
    expect(second.usage.cacheReadTokens).toBeGreaterThan(0);
  });
});
