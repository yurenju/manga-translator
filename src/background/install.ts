/**
 * 安裝與更新（runtime.onInstalled，#93）：決定翻譯模式、onboarding 從哪裡開始、要不要打開 onboarding 分頁。
 * 全新安裝預設內建翻譯並打開 onboarding；從舊版更新、已經設定 key 的讀者維持自備金鑰，只在 side panel 提示一次內建翻譯。
 * 已經決定過翻譯模式（之前的安裝或更新寫過）就不再動：讀者自己選的模式、關掉的提示都不會被下一次更新蓋掉。
 */
import type { OnboardingProgress } from '../shared/onboarding.ts';
import type { TranslationMode } from '../shared/translation-mode.ts';

export interface InstallPlan {
  translationMode: TranslationMode;
  onboarding: OnboardingProgress;
  /** 自動用新分頁打開 onboarding。 */
  openOnboarding: boolean;
  /** side panel 顯示一次「現在也可以改用內建翻譯」。 */
  hostedHint: boolean;
}

export function installPlan({
  reason,
  hasKey,
  migrated,
}: {
  reason: `${chrome.runtime.OnInstalledReason}`;
  /** 已經存了 Anthropic API key（舊版只有自備金鑰）。 */
  hasKey: boolean;
  /** chrome.storage 裡已經有翻譯模式。 */
  migrated: boolean;
}): InstallPlan | undefined {
  if (reason === 'install') return { translationMode: 'hosted', onboarding: 'intro', openOnboarding: true, hostedHint: false };
  if (reason !== 'update' || migrated) return undefined;
  if (hasKey) return { translationMode: 'ownKey', onboarding: 'done', openOnboarding: false, hostedHint: true };
  // 舊版沒設定過 key 的讀者本來就不能翻：跟新安裝一樣走內建翻譯，side panel 請他完成設定；更新是背景發生的，不主動開分頁
  return { translationMode: 'hosted', onboarding: 'intro', openOnboarding: false, hostedHint: false };
}
