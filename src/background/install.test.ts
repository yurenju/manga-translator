import { describe, expect, it } from 'vitest';
import { installPlan } from './install.ts';

describe('安裝與更新時的翻譯模式與 onboarding', () => {
  it('全新安裝：預設內建翻譯，onboarding 從第 1 步開始，自動打開 onboarding 分頁', () => {
    expect(installPlan({ reason: 'install', hasKey: false, migrated: false })).toEqual({
      translationMode: 'hosted',
      onboarding: 'intro',
      openOnboarding: true,
      hostedHint: false,
    });
  });

  it('從舊版更新、已經有 key：維持自備金鑰，不開 onboarding，side panel 顯示一次內建翻譯提示', () => {
    expect(installPlan({ reason: 'update', hasKey: true, migrated: false })).toEqual({
      translationMode: 'ownKey',
      onboarding: 'done',
      openOnboarding: false,
      hostedHint: true,
    });
  });

  it('從舊版更新、還沒設定 key：改成內建翻譯、還沒做完設定（side panel 顯示「完成設定」），但不主動開分頁', () => {
    expect(installPlan({ reason: 'update', hasKey: false, migrated: false })).toEqual({
      translationMode: 'hosted',
      onboarding: 'intro',
      openOnboarding: false,
      hostedHint: false,
    });
  });

  it('之後的更新（已經決定過翻譯模式）：什麼都不動，關掉的提示不會再出現', () => {
    expect(installPlan({ reason: 'update', hasKey: true, migrated: true })).toBeUndefined();
    expect(installPlan({ reason: 'update', hasKey: false, migrated: true })).toBeUndefined();
  });

  it('Chrome 本身更新、共用模組更新：什麼都不動', () => {
    expect(installPlan({ reason: 'chrome_update', hasKey: false, migrated: false })).toBeUndefined();
    expect(installPlan({ reason: 'shared_module_update', hasKey: true, migrated: false })).toBeUndefined();
  });
});
