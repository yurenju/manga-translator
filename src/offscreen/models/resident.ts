/**
 * 讓模型常駐記憶體、閒置一段時間後釋放（spec #27 第 2 節、ADR 0001）。
 * 載入很貴（冷啟動 3–4 s、記憶體 0.9–1.4 GB），連續翻頁時不能每頁重載；不讀的時候也不該一直佔著。
 */
export interface ResidentDeps<T> {
  create(): Promise<T>;
  dispose(value: T): Promise<void>;
  /** 最後一次使用結束後過這麼久沒再用就釋放。 */
  idleMs: number;
}

export function createResident<T>(deps: ResidentDeps<T>) {
  let value: Promise<T> | undefined;
  let inUse = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function scheduleRelease(): void {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const current = value;
      value = undefined;
      if (current) void current.then(deps.dispose, () => {});
    }, deps.idleMs);
  }

  async function use<R>(fn: (value: T) => Promise<R>): Promise<R> {
    clearTimeout(timer);
    inUse++;
    try {
      value ??= deps.create();
      let current: T;
      try {
        current = await value;
      } catch (e) {
        value = undefined;
        throw e;
      }
      return await fn(current);
    } finally {
      inUse--;
      if (inUse === 0 && value) scheduleRelease();
    }
  }

  return { use };
}
