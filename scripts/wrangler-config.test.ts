/**
 * worker/wrangler.jsonc 的 vars 與 bindings 不會從最上層繼承，每個 env 各寫一次。Worker 合併到 main 就自動部署（ADR 0008），
 * 在 env.dev 加了設定卻忘了加到最上層（production），部署會成功，執行時才出錯，所以在這裡檢查。
 */
import { experimental_readRawConfig } from 'wrangler';
import { describe, expect, it } from 'vitest';

const { rawConfig } = experimental_readRawConfig({ config: 'worker/wrangler.jsonc' });

/** 只給本機用的 vars：production 不能有。 */
const DEV_ONLY_VARS = ['FAKE_MAIL', 'DEV_ENDPOINTS'];

const names = (items: { binding?: string; name?: string }[] | undefined) => (items ?? []).map((i) => i.binding ?? i.name).sort();

describe('worker/wrangler.jsonc', () => {
  it('env.dev 的 vars，production 都有（只給本機用的除外）', () => {
    const dev = Object.keys(rawConfig.env?.dev?.vars ?? {}).filter((name) => !DEV_ONLY_VARS.includes(name));

    expect(Object.keys(rawConfig.vars ?? {})).toEqual(expect.arrayContaining(dev));
  });

  it('production 沒有只給本機用的 vars', () => {
    for (const name of DEV_ONLY_VARS) expect(rawConfig.vars ?? {}).not.toHaveProperty(name);
  });

  it('每個 env 的 D1 與頻率限制 bindings 都一樣', () => {
    for (const env of Object.values(rawConfig.env ?? {}) as (typeof rawConfig)[]) {
      expect(names(env.d1_databases)).toEqual(names(rawConfig.d1_databases));
      expect(names(env.ratelimits)).toEqual(names(rawConfig.ratelimits));
    }
  });
});
