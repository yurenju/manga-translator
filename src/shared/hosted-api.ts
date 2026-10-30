/**
 * 外掛與 Worker 之間的 API 契約（spec #86「Worker API」）：路徑、請求與回應的形狀、錯誤。外掛的 Hosted Translation Translator、
 * 登入畫面與 Worker 都 import 這一份。
 *
 * 翻譯與 Notes：body 是 TranslateInput／NotesInput 原樣（結構化輸入，不是 prompt）；回應是 TranslateOutput／NotesOutput
 * （latencyMs 只算 Worker 到 Anthropic，外掛換成自己量的）。要帶 `Authorization: Bearer <session token>`。
 *
 * 錯誤回應一律是 HostedError：401 沒登入（reason signedOut）、400 輸入格式不符或驗證碼不對、402 額度用完、
 * 429 寄送太頻繁、404 沒有這個端點、502 Anthropic 重試後仍失敗。
 */
export const TRANSLATE_PATH = '/v1/translate';
export const NOTES_PATH = '/v1/notes';

/** POST { email }：寄出 6 位數驗證碼，204。 */
export const SEND_CODE_PATH = '/v1/auth/send-code';
/** POST { email, code }：驗證成功回 VerifyCodeResponse；第一次驗證成功時建立 Account。 */
export const VERIFY_CODE_PATH = '/v1/auth/verify';
/** POST（帶 token）：撤銷這個 token，204。 */
export const SIGN_OUT_PATH = '/v1/auth/sign-out';
/** GET（帶 token）：目前的 Account 狀態 AccountResponse。 */
export const ACCOUNT_PATH = '/v1/account';
/**
 * GET ?email=：假的寄信實作最後寄給這個 email 的驗證碼 { code }。只有 FAKE_MAIL 的 env（dev、test）有，
 * browser test 與本機開發用它代替收信；production 一律 404。
 */
export const DEV_OUTBOX_PATH = '/v1/dev/outbox';
/**
 * POST { email, remaining }：把這個 email 的 Account 的免費額度改成 remaining 頁，204。只有 DEV_ENDPOINTS 的 env（dev、test）有，
 * browser test 與本機開發用它試「快用完」「用完」的畫面；production 一律 404。
 */
export const DEV_FREE_PAGES_PATH = '/v1/dev/free-pages';

export interface VerifyCodeResponse {
  /** 長期有效的 session token；每次使用都會延長期限。 */
  token: string;
}

/**
 * 剩餘額度（spec #86「額度規則」）：沒有訂閱時只有 Free Pages，remaining 是剩下的免費頁數。
 * #94 加上訂閱者的本月額度（plan 'subscribed'、重置日期）。外掛只顯示這裡的數字，不自己算。
 */
/** 新 Account 一次性的免費頁數（Worker 發額度、設定頁顯示「剩 N / 50 頁」）。 */
export const FREE_PAGES = 50;

export interface Quota {
  plan: 'free';
  remaining: number;
}

export interface AccountResponse {
  email: string;
  quota: Quota;
}

/**
 * 外掛要依原因換畫面的錯誤：
 * - signedOut：沒帶 token、token 錯誤、過期或已撤銷
 * - rateLimited：寄送驗證碼太頻繁（依 IP 與 email）
 * - wrongCode／codeExpired／tooManyAttempts：驗證碼錯、過期（或沒寄過）、錯太多次這組已失效
 * - freePagesExhausted：沒有訂閱、免費額度用完（402）；訂閱結束後免費額度也是 0 的也是這個
 */
export type HostedErrorReason = 'signedOut' | 'rateLimited' | 'wrongCode' | 'codeExpired' | 'tooManyAttempts' | 'freePagesExhausted';

export interface HostedError {
  error: string;
  reason?: HostedErrorReason;
}
