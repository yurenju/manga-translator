import { describe, expect, it } from 'vitest';
import { readGroundTruth, SYNTHETIC_IDS } from '../testing/synthetic.ts';
import { alignRuby, type RubySegment } from './ruby.ts';

const hasKanji = (s: string) => /[一-鿿々〆ヶ]/.test(s);

describe('alignRuby：整句讀音對齊回每段漢字', () => {
  it('漢字段帶讀音、假名段原樣', () => {
    expect(alignRuby('一緒に行ってもいい？', 'いっしょにいってもいい？')).toEqual([
      { text: '一緒', rt: 'いっしょ' },
      { text: 'に' },
      { text: '行', rt: 'い' },
      { text: 'ってもいい？' },
    ]);
  });

  it('義訓保留讀音原本的片假名（本気→マジ）', () => {
    expect(alignRuby('本気で言ってるのか!?', 'マジでいってるのか!?')).toEqual([
      { text: '本気', rt: 'マジ' },
      { text: 'で' },
      { text: '言', rt: 'い' },
      { text: 'ってるのか!?' },
    ]);
  });

  it('原文的片假名詞、讀音寫成平假名也對得上', () => {
    expect(alignRuby('カップ麺', 'かっぷめん')).toEqual([{ text: 'カップ' }, { text: '麺', rt: 'めん' }]);
  });

  it('讀音少了標點或多了空白也對得上', () => {
    expect(alignRuby('本気で言ってるのか!?', 'マジで いってるのか')).toEqual([
      { text: '本気', rt: 'マジ' },
      { text: 'で' },
      { text: '言', rt: 'い' },
      { text: 'ってるのか!?' },
    ]);
  });

  it('沒有漢字：整句原樣、沒有讀音', () => {
    expect(alignRuby('もちろん！', 'もちろん！')).toEqual([{ text: 'もちろん！' }]);
  });

  it('對不上（數字寫成假名、讀音跟原文不符、沒有讀音）退回 null', () => {
    expect(alignRuby('駅前に7時ね', 'えきまえにしちじね')).toBeNull();
    expect(alignRuby('今日は早いね', 'あしたはおそいよ')).toBeNull();
    expect(alignRuby('今日', '')).toBeNull();
  });
});

describe('alignRuby 在合成頁 ground truth 上', () => {
  const texts = SYNTHETIC_IDS.flatMap((id) => readGroundTruth(id).texts.map((t) => ({ ...t, page: id })));
  const withKanji = texts.filter((t) => hasKanji(t.ja));

  it('對齊率 ≥ 90%，對上的每段讀音都跟 ground truth 的ルビ一致', () => {
    const aligned = withKanji.map((t) => ({ t, segments: alignRuby(t.ja, t.reading) }));
    const ok = aligned.filter((a): a is { t: (typeof a)['t']; segments: RubySegment[] } => a.segments !== null);
    const failed = aligned.filter((a) => a.segments === null).map((a) => `${a.t.page} ${a.t.id} ${a.t.ja}`);
    console.log(`對齊 ${ok.length}/${withKanji.length}；退回整句：${failed.join(' / ')}`);
    expect(ok.length / withKanji.length).toBeGreaterThanOrEqual(0.9);

    let checked = 0;
    for (const { t, segments } of ok) {
      // ground truth 的ルビ依序落在各個漢字段裡；同一段的ルビ串起來就是那段的讀音
      let rest = [...(t.ruby ?? [])];
      for (const seg of segments) {
        if (seg.rt === undefined) continue;
        const inSeg: string[] = [];
        let covered = '';
        while (rest[0] && seg.text.includes(rest[0].base) && covered.length < seg.text.length) {
          covered += rest[0].base;
          inSeg.push(rest[0].rt);
          rest = rest.slice(1);
        }
        // ground truth 只標了部分漢字（例如 p01 沒有ルビ）就不比
        if (covered !== seg.text) continue;
        expect(seg.rt, `${t.page} ${t.id} ${seg.text}`).toBe(inSeg.join(''));
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(50);
  });

  it('對不上的只有數字寫成假名的句子（退回整句讀音）', () => {
    const failed = withKanji.filter((t) => alignRuby(t.ja, t.reading) === null).map((t) => t.ja);
    expect(failed.sort()).toEqual(['あと10分で着く訳ない！', '潮見坂高校4月12日', '駅前に7時ね'].sort());
  });
});
