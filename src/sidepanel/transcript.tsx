/**
 * 學習模式的逐字稿（spec #27 第 8 節、#21 的變體 B）：依閱讀順序一行一句，上方全域切換顯示層級，
 * 振り仮名用 rubyDisplay（alignRuby）對齊回每段漢字，頁面 ↔ panel 的 hover 同步。
 */
import { useEffect, useRef } from 'preact/hooks';
import type { PageText } from '../shared/page-text.ts';
import { rubyDisplay } from '../shared/ruby.ts';

/** 全域顯示層級：整頁一起切。 */
export const LEVELS = ['只看譯文', '原文＋譯文', '加振り仮名', '只看日文'] as const;
export type Level = (typeof LEVELS)[number];
export const DEFAULT_LEVEL: Level = '加振り仮名';

export function LevelSwitch({ level, onChange }: { level: Level; onChange: (level: Level) => void }) {
  return (
    <>
      <div role="group" aria-label="顯示層級" class="levels">
        {LEVELS.map((l) => (
          <button key={l} type="button" aria-pressed={l === level} onClick={() => onChange(l)}>
            {l}
          </button>
        ))}
      </div>
      {level === '加振り仮名' && <p class="ruby-legend">ルビ為 LLM 推測，義訓可能讀錯（例：本気 マジ）。滑過頁面上的 Balloon 看提示。</p>}
    </>
  );
}

/** 原文＋ルビ；對不上時退回「原文＋下面一行整句讀音」。 */
function Ruby({ ja, reading }: { ja: string; reading: string }) {
  const display = rubyDisplay(ja, reading);
  if ('fallback' in display)
    return (
      <>
        {ja}
        <span class="reading" lang="ja">
          {display.fallback}
        </span>
      </>
    );
  return (
    <>
      {display.segments.map((s, i) =>
        s.rt === undefined ? (
          s.text
        ) : (
          <ruby key={i}>
            {s.text}
            <rt>{s.rt}</rt>
          </ruby>
        ),
      )}
    </>
  );
}

export interface TranscriptProps {
  text: PageText;
  translated: boolean;
  level: Level;
  /** 頁面上滑鼠所在的那句（高亮並捲過去）。 */
  hoveredId: string | undefined;
  /** 滑過這行（null＝離開）→ 頁面上那句高亮。 */
  onHover: (lineId: string | null) => void;
}

/** 逐字稿：Balloon 與 Loose Text 依閱讀順序混在同一串；Loose Text 用斜體＋🔊。 */
export function Transcript({ text, translated, level, hoveredId, onHover }: TranscriptProps) {
  const lines = [
    ...text.balloons.map((b) => ({ ...b, loose: false })),
    ...text.looseText.map((l) => ({ ...l, loose: true })),
  ].sort((a, b) => a.order - b.order);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (hoveredId === undefined) return;
    list.current?.querySelector('li.hl')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [hoveredId]);

  return (
    <ol aria-label="逐字稿" ref={list}>
      {lines.map((line) => {
        // unreadable：OCR 原文（灰、刪除線）＋「無法辨識 · 未覆蓋」，每個層級都一樣
        const unreadable = translated && line.unreadable;
        const hasTranslation = translated && line.譯文 !== '';
        const showOriginal = unreadable || level !== '只看譯文' || !hasTranslation;
        const showTranslation = !unreadable && level !== '只看日文';
        const ja = level === '加振り仮名' && !unreadable ? <Ruby ja={line.原文} reading={line.讀音} /> : line.原文;
        const cls = unreadable ? ' unreadable' : '';
        const original = line.loose ? <em class={`loose${cls}`}>🔊 {ja}</em> : <span class={`original${cls}`}>{ja}</span>;
        return (
          <li
            key={line.id}
            data-kind={line.loose ? 'loose' : 'balloon'}
            class={line.id === hoveredId ? 'hl' : undefined}
            onMouseEnter={() => onHover(line.id)}
            onMouseLeave={() => onHover(null)}
          >
            {showOriginal && original}
            {unreadable && <span class="unreadable-label">無法辨識 · 未覆蓋</span>}
            {showTranslation &&
              (hasTranslation ? <span class="translation">{line.譯文}</span> : <span class="untranslated">未翻譯</span>)}
          </li>
        );
      })}
    </ol>
  );
}
