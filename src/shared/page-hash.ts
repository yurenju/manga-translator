/**
 * Page 的身分：縮圖 perceptual hash（ADR 0003、spec #27 第 4.3 節）。翻譯快取用它當 key，比對用 Hamming 距離門檻。
 *
 * 演算法是 pHash：區塊平均縮到 64×64 → 2D DCT → 取左上 16×16 個低頻係數 → 大於（不含 DC 的）中位數為 1，共 256 bits。
 * 在合成頁上量過 aHash／dHash／pHash（#33 的 commit message 有數字）：pHash 對縮放與 JPEG 失真最穩、
 * 不同頁也分得最開；dHash 在大片白底上相鄰區塊亮度幾乎一樣，縮放雜訊就會翻轉，同頁與不同頁的距離會重疊。
 *
 * 縮小自己做區塊平均，不交給 canvas：瀏覽器（offscreen）跟 Node（單元測試）算出來的 hash 一樣。
 */

/** 縮到這麼大再做 DCT。 */
const GRID = 64;
/** 取左上 KEEP×KEEP 個低頻係數。 */
const KEEP = 16;

/**
 * Hamming 距離在這以內算同一個 Page（256 bits）。合成頁量測：同頁經縮放／JPEG／裁掉 2px 最多 20，
 * 不同頁最少 106（p07 Spread 的左右兩頁）。取 40：比同頁最差多一倍餘裕；認錯頁（蓋上別頁的譯文）比沒命中
 * （多花一次翻譯）糟，所以門檻偏向同頁那一側。
 */
export const SAME_PAGE_MAX_DISTANCE = 40;

export interface GrayImage {
  gray: Uint8Array;
  width: number;
  height: number;
}

/** 依面積加權的區塊平均，任意尺寸縮到 size×size。 */
function areaAverage({ gray, width, height }: GrayImage, size: number): Float64Array {
  const out = new Float64Array(size * size);
  for (let gy = 0; gy < size; gy++) {
    const y0 = (gy * height) / size;
    const y1 = ((gy + 1) * height) / size;
    for (let gx = 0; gx < size; gx++) {
      const x0 = (gx * width) / size;
      const x1 = ((gx + 1) * width) / size;
      let sum = 0;
      let area = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const w = (Math.min(x + 1, x1) - Math.max(x, x0)) * wy;
          sum += gray[y * width + x]! * w;
          area += w;
        }
      }
      out[gy * size + gx] = sum / area;
    }
  }
  return out;
}

/** cos 表：COS[k * GRID + n] = cos((2n+1)kπ / 2·GRID)。 */
const COS = Float64Array.from({ length: KEEP * GRID }, (_, i) => Math.cos(((2 * (i % GRID) + 1) * Math.floor(i / GRID) * Math.PI) / (2 * GRID)));

export function pageHash(image: GrayImage): string {
  const pixels = areaAverage(image, GRID);
  // 分離式 DCT：先對每一列取 KEEP 個係數，再對每一行。
  const rows = new Float64Array(GRID * KEEP);
  for (let y = 0; y < GRID; y++) {
    for (let u = 0; u < KEEP; u++) {
      let sum = 0;
      for (let x = 0; x < GRID; x++) sum += pixels[y * GRID + x]! * COS[u * GRID + x]!;
      rows[y * KEEP + u] = sum;
    }
  }
  const coefs: number[] = [];
  for (let v = 0; v < KEEP; v++) {
    for (let u = 0; u < KEEP; u++) {
      let sum = 0;
      for (let y = 0; y < GRID; y++) sum += rows[y * KEEP + u]! * COS[v * GRID + y]!;
      coefs.push(sum);
    }
  }
  // DC（平均亮度）不參與中位數，它的 bit 固定是 0。
  const ac = coefs.slice(1).sort((a, b) => a - b);
  const median = (ac[(ac.length - 1) >> 1]! + ac[ac.length >> 1]!) / 2;
  let hex = '';
  for (let i = 0; i < coefs.length; i += 4) {
    let nibble = 0;
    for (let j = 0; j < 4; j++) nibble = (nibble << 1) | (i + j > 0 && coefs[i + j]! > median ? 1 : 0);
    hex += nibble.toString(16);
  }
  return hex;
}

export function hammingDistance(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    for (; x; x &= x - 1) distance++;
  }
  return distance;
}

/** 門檻內最接近 hash 的那一筆；都在門檻外就是 undefined。 */
export function findSamePage<T extends { pageHash: string }>(entries: readonly T[], hash: string): T | undefined {
  let best: T | undefined;
  let bestDistance = SAME_PAGE_MAX_DISTANCE;
  for (const entry of entries) {
    const distance = hammingDistance(entry.pageHash, hash);
    if (distance <= bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best;
}
