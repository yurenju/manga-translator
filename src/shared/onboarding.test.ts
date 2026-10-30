import { describe, expect, it } from 'vitest';
import { startStep } from './onboarding.ts';

describe('onboarding 從哪一步開始', () => {
  it('回到停下來的那一步', () => {
    expect(startStep('intro', false)).toBe('intro');
    expect(startStep('signIn', false)).toBe('signIn');
  });

  it('已經登入：第 2 步直接跳到第 3 步（選擇方案）', () => {
    expect(startStep('signIn', true)).toBe('plan');
    expect(startStep('plan', true)).toBe('plan');
  });

  it('停在選擇方案，但登入已經失效：回到第 2 步', () => {
    expect(startStep('plan', false)).toBe('signIn');
  });

  it('side panel 的「登入」「改用內建翻譯」：從第 2 步開始，即使設定早就完成', () => {
    expect(startStep('done', false, 'signIn')).toBe('signIn');
    expect(startStep('done', true, 'signIn')).toBe('plan');
  });
});
