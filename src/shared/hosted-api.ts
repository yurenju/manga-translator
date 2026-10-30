/**
 * 外掛與 Worker 之間的 API 契約（spec #86「Worker API」）：路徑與開發用 token。外掛的 Hosted Translation Translator
 * 與 Worker 都 import 這一份。請求 body 是 TranslateInput／NotesInput 原樣（結構化輸入，不是 prompt）；
 * 回應是 TranslateOutput／NotesOutput（latencyMs 只算 Worker 到 Anthropic，外掛換成自己量的）。錯誤回應是 HostedError：
 * 401 沒登入、400 輸入格式不符、502 Anthropic 重試後仍失敗。
 */
export const TRANSLATE_PATH = '/v1/translate';
export const NOTES_PATH = '/v1/notes';

/**
 * 還沒有 Account 時（#90）先用的固定 token。Worker 只在 ALLOW_DEV_TOKEN（wrangler.jsonc 的 env.dev／env.test）
 * 時接受它，production 一律拒絕；外掛只有 e2e 與 debug build 會帶。登入（#91）換成 session token。
 */
export const DEV_SESSION_TOKEN = 'naruhodo-dev-session-token';

export interface HostedError {
  error: string;
}
