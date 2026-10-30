import { describe, expect, it } from 'vitest';
import { pickLocale } from './locale.ts';

describe('pickLocale', () => {
  it('中文瀏覽器用繁體中文', () => {
    expect(pickLocale({ browserLanguages: ['zh-TW', 'en-US'] })).toBe('zh-tw');
  });

  it('照瀏覽器偏好的順序，跳過網站沒有的語系', () => {
    expect(pickLocale({ browserLanguages: ['ja-JP', 'zh-TW', 'en'] })).toBe('zh-tw');
    expect(pickLocale({ browserLanguages: ['ja-JP', 'en-US', 'zh-TW'] })).toBe('en');
  });

  it('不是中文也不是英文時用英文', () => {
    expect(pickLocale({ browserLanguages: ['ja-JP', 'ko'] })).toBe('en');
    expect(pickLocale({ browserLanguages: [] })).toBe('en');
  });

  it('讀者手動切換過的語言優先於瀏覽器語系', () => {
    expect(pickLocale({ saved: 'en', browserLanguages: ['zh-TW'] })).toBe('en');
    expect(pickLocale({ saved: 'zh-tw', browserLanguages: ['en-US'] })).toBe('zh-tw');
  });

  it('存下來的值不是網站語系時當作沒選過', () => {
    expect(pickLocale({ saved: 'ja', browserLanguages: ['zh-TW'] })).toBe('zh-tw');
    expect(pickLocale({ saved: null, browserLanguages: ['zh-TW'] })).toBe('zh-tw');
  });

  it('連結帶來的語言（從哪個語言的頁面點進法律文件）最優先，不是網站語系就忽略', () => {
    expect(pickLocale({ requested: 'zh-tw', saved: 'en', browserLanguages: ['en-US'] })).toBe('zh-tw');
    expect(pickLocale({ requested: 'fr', saved: 'zh-tw', browserLanguages: ['en-US'] })).toBe('zh-tw');
  });
});
