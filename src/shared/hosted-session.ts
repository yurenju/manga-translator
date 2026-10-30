/**
 * 外掛這邊的 Hosted Translation 連線資訊：Worker 的網址與 session token。
 * #90 還沒有登入：e2e 與 debug build 帶開發用 token，正式 build 沒有 token，所以 Hosted Translation 不會翻譯。
 * 登入（#91）把 token 改存外掛 origin 的 IndexedDB（跟 API key 同一處，content script 讀不到）。
 */
import { DEV_SESSION_TOKEN } from './hosted-api.ts';

/** scripts/build.ts 依 build 決定；正式 build 的網址還沒定（''）。 */
export const HOSTED_API_URL = __HOSTED_API_URL__;

/** 已登入時的 session token；沒有就是 undefined（跟沒有 key 一樣，只顯示原文與讀音）。 */
export async function hostedSessionToken(): Promise<string | undefined> {
  return HOSTED_API_URL && (__E2E__ || __DEBUG__) ? DEV_SESSION_TOKEN : undefined;
}
