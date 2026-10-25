import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResident } from './resident.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(idleMs = 1000) {
  let created = 0;
  const disposed: number[] = [];
  const resident = createResident({
    create: async () => ++created,
    dispose: async (n) => {
      disposed.push(n);
    },
    idleMs,
  });
  return { resident, disposed, created: () => created };
}

describe('模型常駐、閒置後釋放', () => {
  it('連續使用時只載入一次', async () => {
    const { resident, created } = setup();

    await resident.use(async () => {});
    await resident.use(async () => {});

    expect(created()).toBe(1);
  });

  it('最後一次使用後閒置超過時間就釋放，下次使用重新載入', async () => {
    const { resident, disposed, created } = setup(1000);
    await resident.use(async () => {});

    await vi.advanceTimersByTimeAsync(999);
    expect(disposed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(disposed).toEqual([1]);

    expect(await resident.use(async (n) => n)).toBe(2);
    expect(created()).toBe(2);
  });

  it('使用中不會被釋放；重新使用會重新計時', async () => {
    const { resident, disposed } = setup(1000);
    let finish!: () => void;
    const running = resident.use(() => new Promise<void>((resolve) => (finish = resolve)));
    await vi.advanceTimersByTimeAsync(5000);
    expect(disposed).toEqual([]);

    finish();
    await running;
    await vi.advanceTimersByTimeAsync(600);
    await resident.use(async () => {});
    await vi.advanceTimersByTimeAsync(600);
    expect(disposed).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(disposed).toEqual([1]);
  });

  it('載入失敗時下次使用會重試', async () => {
    let attempts = 0;
    const resident = createResident({
      create: async () => {
        attempts++;
        if (attempts === 1) throw new Error('下載失敗');
        return 'ok';
      },
      dispose: async () => {},
      idleMs: 1000,
    });

    await expect(resident.use(async () => {})).rejects.toThrow('下載失敗');
    expect(await resident.use(async (v) => v)).toBe('ok');
  });
});
