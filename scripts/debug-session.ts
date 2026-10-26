/**
 * 除錯錄製的純邏輯：session 資料夾命名與清理、把記錄裡的圖片抽成檔案（scripts/debug-chrome.ts），
 * 以及時間軸摘要（scripts/debug-summary.ts）。
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

/** 最新的 session 名稱；沒有就是 undefined。 */
export function latestSession(names: readonly string[]): string | undefined {
  return sessionsToPrune(names, 0)[0];
}

/** trace.jsonl 的一行：除錯記錄（src/shared/debug-trace.ts），或錄製端加的 console／例外（有 text）。 */
export interface SessionRecord {
  ctx: string;
  event: string;
  at: number;
  data?: Record<string, unknown>;
  text?: string;
}

const HASH = /^[0-9a-f]{64}$/;

const isRect = (value: object): value is { x: number; y: number; width: number; height: number } =>
  ['x', 'y', 'width', 'height'].every((key) => typeof (value as Record<string, unknown>)[key] === 'number') && Object.keys(value).length === 4;

/** extractImages 換上的圖片路徑；摘要不印，要看圖就去讀那一行。 */
const IMAGE_PATH = /^images\/\d+-[\w-]+\.\w+$/;

/** 幾個量大的事件只留看時間軸要的：crop 每頁 "anchorId:hash前8碼"，overlay:show 的 fits 只留數量與有沒有被截斷。 */
function digest(record: SessionRecord): Record<string, unknown> {
  const data = record.data ?? {};
  if (record.event === 'crop') {
    const pages = (data.pages ?? []) as { anchorId: string; pageHash: string }[];
    return { ...(data.ms === undefined ? {} : { ms: data.ms }), pages: pages.map((page) => `${page.anchorId}:${page.pageHash.slice(0, 8)}`) };
  }
  if (record.event === 'overlay:show' && Array.isArray(data.fits)) {
    const fits = data.fits as { truncated?: boolean }[];
    return { ...data, fits: { count: fits.length, truncated: fits.some((fit) => fit.truncated === true) } };
  }
  return data;
}

/** 讓一行看得完：Page hash 只留前 8 碼、rect 寫成 "x,y wxh"、被排除的候選只列各原因的數量、圖片路徑不印。 */
function compact(value: unknown, key?: string): unknown {
  if (typeof value === 'string') return HASH.test(value) ? value.slice(0, 8) : value;
  if (typeof value === 'number') return Math.round(value * 10) / 10;
  if (Array.isArray(value)) {
    if (key === 'rejected') {
      const counts: Record<string, number> = {};
      for (const item of value as { reason: string }[]) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
      return counts;
    }
    return value.map((item) => compact(item));
  }
  if (value !== null && typeof value === 'object') {
    if (isRect(value)) return `${Math.round(value.x)},${Math.round(value.y)} ${Math.round(value.width)}x${Math.round(value.height)}`;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => !(typeof v === 'string' && IMAGE_PATH.test(v)))
        .map(([k, v]) => [k, compact(v, k)]),
    );
  }
  return value;
}

/**
 * 給人（與 Claude）讀的時間軸：每筆一行，開頭是 trace.jsonl 的行號（要看完整內容就去讀那一行）與距第一筆的秒數。
 * 跟上一筆 candidates 一樣的 candidates 不列（掃描時截圖前後各量一次）。
 * since：只列行號大於它的（接著上次讀到的地方看）；秒數仍從整個 session 的第一筆算。
 */
export function summarize(records: readonly SessionRecord[], { since = 0 }: { since?: number } = {}): string[] {
  const start = records[0]?.at ?? 0;
  const lines: string[] = [];
  let lastCandidates: string | undefined;
  for (const [i, record] of records.entries()) {
    const detail = record.text ?? JSON.stringify(compact(digest(record)));
    if (record.event === 'candidates') {
      if (detail === lastCandidates) continue;
      lastCandidates = detail;
    }
    if (i + 1 <= since) continue;
    lines.push(`${String(i + 1).padStart(5)} ${((record.at - start) / 1000).toFixed(1).padStart(7)} ${record.ctx} ${record.event} ${detail}`);
  }
  return lines;
}
