/**
 * 全頁 onboarding（#93）的進度與內建翻譯提示，存在 chrome.storage.local。
 * SW 在安裝／更新時寫（background/install.ts），onboarding 頁每走一步寫，side panel 讀：
 * 沒做完就只顯示「完成設定」，按了打開 onboarding、回到停下來的那一步。
 */
import { watchLocal } from './watch-local.ts';

/** onboarding 的步驟（第 1–4 步）；ownKey＝頁尾「使用自備金鑰」換成的畫面（不在步驟裡）。 */
export type OnboardingStep = 'intro' | 'signIn' | 'plan' | 'tutorial' | 'ownKey';

/**
 * 進度：停在哪一步，done＝設定完成（選了方案或存了自己的 key；第 4 步只是教學）。
 * 沒有值＝#93 以前就裝好的外掛（e2e build 預設也是），當作完成。
 */
export type OnboardingProgress = 'intro' | 'signIn' | 'plan' | 'done';

const PROGRESS_KEY = 'onboarding';
/** true＝從舊版更新、仍用自備金鑰的讀者還沒看過（或還沒關掉）內建翻譯提示。 */
const HINT_KEY = 'hostedHint';

const PROGRESS: readonly OnboardingProgress[] = ['intro', 'signIn', 'plan', 'done'];

const parseProgress = (value: unknown): OnboardingProgress => (PROGRESS.includes(value as OnboardingProgress) ? (value as OnboardingProgress) : 'done');

/** onboarding 頁從哪一步開始：side panel 要的是「登入」就從第 2 步；已登入的話第 2 步直接跳到第 3 步。 */
export function startStep(progress: OnboardingProgress, signedIn: boolean, requested?: 'signIn'): OnboardingStep {
  const step = requested ?? (progress === 'done' ? 'intro' : progress);
  if (step === 'intro') return 'intro';
  return signedIn ? 'plan' : 'signIn';
}

/** 外掛自己的 onboarding 頁；step＝signIn 從第 2 步開始（side panel 的「登入」「改用內建翻譯」）。 */
export function onboardingUrl(step?: 'signIn'): string {
  return chrome.runtime.getURL(step ? `onboarding.html?step=${step}` : 'onboarding.html');
}

export async function loadOnboarding(): Promise<OnboardingProgress> {
  return parseProgress((await chrome.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY]);
}

export function saveOnboarding(progress: OnboardingProgress): Promise<void> {
  return chrome.storage.local.set({ [PROGRESS_KEY]: progress });
}

export function dismissHostedHint(): Promise<void> {
  return chrome.storage.local.remove(HINT_KEY);
}

export const watchOnboarding = (onChange: (progress: OnboardingProgress) => void) => watchLocal(PROGRESS_KEY, parseProgress, onChange);

export const watchHostedHint = (onChange: (show: boolean) => void) => watchLocal(HINT_KEY, (value) => value === true, onChange);

/** SW 安裝／更新時一次寫好（background/install.ts）。 */
export function saveInstallState(state: { onboarding: OnboardingProgress; hostedHint: boolean }): Promise<void> {
  return chrome.storage.local.set({ [PROGRESS_KEY]: state.onboarding, [HINT_KEY]: state.hostedHint });
}
