/**
 * 在 side panel 的設定區用 email 驗證碼登入內建翻譯（#91）：寄送 → 從本機 Worker 假的寄信實作取出驗證碼 → 登入。
 * browser test 與 smoke 共用；每個測試傳不同的 email，Worker 的狀態不會互相影響。
 */
import type { Locator } from '@playwright/test';
import { DEV_OUTBOX_PATH } from '../src/shared/hosted-api.ts';
import { expect } from './fixtures.ts';
import { WORKER_URL } from './worker.ts';

/** 假的寄信實作最後寄給這個 email 的驗證碼。 */
async function lastCode(email: string): Promise<string> {
  const response = await fetch(`${WORKER_URL}${DEV_OUTBOX_PATH}?email=${encodeURIComponent(email)}`);
  return ((await response.json()) as { code: string }).code;
}

/** settings＝「API key 與模型」區塊（翻譯方式已選內建翻譯、還沒登入）。 */
export async function signInWithEmail(settings: Locator, email: string): Promise<void> {
  await settings.getByRole('region', { name: '同意並登入' }).getByLabel('Email').fill(email);
  await settings.getByRole('button', { name: '同意並寄送驗證碼' }).click();
  const verify = settings.getByRole('region', { name: '輸入驗證碼' });
  await expect(verify.getByText(email)).toBeVisible();
  await verify.getByLabel('驗證碼').fill(await lastCode(email));
  await verify.getByRole('button', { name: '登入' }).click();
  await expect(settings.getByText(`已登入：${email}`)).toBeVisible();
}
