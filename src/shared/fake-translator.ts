/**
 * e2e 用的 Translator（spec #27 第 12 節）：回傳合成頁 ground truth 的讀音與譯文，不花錢、結果固定、不需要 API key。
 * TranslateInput 沒有座標，所以用原文相似度（1 − 字元編輯距離 / 長度）把 OCR 結果對回 ground truth。
 */
import type { NotesChanges, TranslateInput, TranslateOutput, Translator } from './translator.ts';

/** 找不到對應的 ground truth 時的譯文。 */
export const NO_MATCH = '（FakeTranslator：找不到對應的原文）';

/** 相似度至少這麼高才算同一句。 */
const MIN_SIMILARITY = 0.5;

export interface GroundTruthText {
  ja: string;
  reading: string;
  zh: string;
}

const normalize = (s: string) => s.normalize('NFKC').replace(/\s/g, '');

function levenshtein(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function similarity(a: string, b: string): number {
  const x = [...normalize(a)];
  const y = [...normalize(b)];
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length, 1);
}

export interface FakeTranslatorOptions {
  /** 這些 ground truth 原文回傳 unreadable（模擬 Claude 判定 OCR 亂碼）。 */
  unreadableTexts?: readonly string[];
  /** 這些條目在某頁的 Balloon 原文裡出現、而且送來的 Notes 還沒有時，當成那頁新增的條目回傳（#37 的 e2e）。 */
  notes?: NotesChanges['added'];
}

export function createFakeTranslator(
  pages: readonly { texts: readonly GroundTruthText[] }[],
  { unreadableTexts = [], notes = [] }: FakeTranslatorOptions = {},
): Translator {
  const texts = pages.flatMap((p) => p.texts);
  const unreadable = new Set(unreadableTexts);
  return {
    async translatePage(input: TranslateInput): Promise<TranslateOutput> {
      return {
        items: input.items.map((item) => {
          let best: GroundTruthText | undefined;
          let bestScore = MIN_SIMILARITY;
          for (const text of texts) {
            const score = similarity(item.原文, text.ja);
            if (score >= bestScore) {
              best = text;
              bestScore = score;
            }
          }
          if (best && unreadable.has(best.ja)) return { id: item.id, 讀音: '', 譯文: '', unreadable: true };
          return best
            ? { id: item.id, 讀音: best.reading, 譯文: best.zh, unreadable: false }
            : { id: item.id, 讀音: '', 譯文: NO_MATCH, unreadable: false };
        }),
        notes_changes: {
          added: notes.filter(
            (n) =>
              !input.seriesNotes.some((e) => e.原文 === n.原文) &&
              input.items.some((i) => i.kind === 'balloon' && normalize(i.原文).includes(normalize(n.原文))),
          ),
          filled: [],
          suggestions: [],
        },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
        model: 'fake',
        latencyMs: 0,
      };
    },
  };
}
