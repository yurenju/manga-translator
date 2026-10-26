/**
 * 真實 API smoke test 用的 key（spec #27 第 12 節第 4 層）：環境變數 MANGA_TRANSLATOR_ANTHROPIC_KEY，
 * 沒有的話讀 ~/.config/manga-translator/anthropic-api-key。不用 ANTHROPIC_API_KEY（Claude Code 自己用它登入）。
 * key 只在測試程序裡用，不印出、不寫進 log 與報告。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TEST_API_KEY_FILE = join(homedir(), '.config', 'manga-translator', 'anthropic-api-key');

export function readTestApiKey(): string | undefined {
  const fromEnv = process.env.MANGA_TRANSLATOR_ANTHROPIC_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(TEST_API_KEY_FILE, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}
