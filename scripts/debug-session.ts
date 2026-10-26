/**
 * scripts/debug-chrome.ts 的純邏輯：session 資料夾命名與清理、把記錄裡的圖片抽成檔案。
 */

const SESSION_NAME = /^\d{8}-\d{6}$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** 錄製一次＝一個 session 資料夾，用本地時間命名（YYYYMMDD-HHmmss）。 */
export function sessionName(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 超過 keep 個時要刪的舊 session；不是 session 名稱的資料夾不動。 */
export function sessionsToPrune(names: readonly string[], keep: number): string[] {
  return names
    .filter((name) => SESSION_NAME.test(name))
    .sort()
    .reverse()
    .slice(keep);
}

export interface ImageFile {
  path: string;
  bytes: Buffer;
}

const DATA_IMAGE = /^data:image\/([a-z+]+);base64,(.*)$/s;

/**
 * 記錄裡 data:image/ 的字串（截圖、縮圖、偵測疊圖）換成 pathFor(副檔名) 回傳的路徑，圖片另外回傳，
 * trace.jsonl 才不會塞滿 base64。
 */
export function extractImages<T>(data: T, pathFor: (ext: string) => string): { data: T; images: ImageFile[] } {
  const images: ImageFile[] = [];
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const match = DATA_IMAGE.exec(value);
      if (!match) return value;
      const path = pathFor(match[1] === 'jpeg' ? 'jpg' : match[1]!);
      images.push({ path, bytes: Buffer.from(match[2]!, 'base64') });
      return path;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  return { data: walk(data) as T, images };
}
