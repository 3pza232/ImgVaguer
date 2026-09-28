/**
 * 密文混淆：全可逆像素级变换管线。
 * 正向：通道置换 → 异或流 → S 盒替换 → 加性噪声 → 行列移位 → 块内置换 → 块间置换 → 全局像素置换
 * 逆向：严格镜像执行。所有随机性来自 ChaCha20 密钥流，双射保证逐位还原。
 *
 * 每个子步骤/每一轮使用独立 nonce 域；域字节之外填入逐图随机 IV，
 * 保证不同图像（即使同一密钥）绝不共享密钥流。
 *
 * 实现要点：全程就地变换并复用缓冲，分块布局只计算一次。
 * 原实现每轮复制整幅图、每块新建 4 个数组，在移动端会产生数百 MB 垃圾与 GC 抖动。
 */
import { ChaCha20, ivNonce } from './chacha';
import type { SubKeys } from './kdf';
import type { Raster } from './types';

export type BlockSize = 8 | 16 | 32;

/** 单轮各子步骤使用的 nonce 域（互不重叠，并随轮次整体偏移） */
const DOM_CHANNEL = 1;
const DOM_INTRA = 2;
const DOM_BLOCK = 3;
const DOM_XOR = 4;
const DOM_NOISE = 5;
const DOM_GLOBAL_PERM = 6;
const DOM_SBOX = 7;
const DOM_ROW_SHIFT = 8;

const MAX_ROUNDS = 8;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 分块布局：仅与图像尺寸和块大小有关，整个变换过程只计算一次 */
interface BlockLayout {
  rects: Rect[];
  /** 同尺寸块类别；块间置换仅在此类别内进行，保证矩形可搬运 */
  classes: number[][];
}

/** 逐行/逐块循环中复用的缓冲，避免千万级的小对象分配 */
interface Workspace {
  /** 洗牌索引（就地复用） */
  gather: Uint32Array;
  /** 单块像素缓冲 */
  pixels: Uint8ClampedArray;
  /** 块内置换的源拷贝 */
  stage: Uint8ClampedArray;
}

function blockLayout(w: number, h: number, b: number): BlockLayout {
  const rects: Rect[] = [];
  for (let y = 0; y < h; y += b) {
    for (let x = 0; x < w; x += b) {
      rects.push({ x, y, w: Math.min(b, w - x), h: Math.min(b, h - y) });
    }
  }
  const bySize = new Map<string, number[]>();
  rects.forEach((r, i) => {
    const k = `${r.w}x${r.h}`;
    const arr = bySize.get(k);
    if (arr) arr.push(i);
    else bySize.set(k, [i]);
  });
  return { rects, classes: [...bySize.values()] };
}

function workspace(b: number, rects: number): Workspace {
  return {
    gather: new Uint32Array(Math.max(b * b, rects)),
    pixels: new Uint8ClampedArray(b * b * 4),
    stage: new Uint8ClampedArray(b * b * 4),
  };
}

function readBlock(data: Uint8ClampedArray, w: number, r: Rect, out: Uint8ClampedArray): void {
  const row = r.w * 4;
  for (let y = 0; y < r.h; y++) {
    const s = ((r.y + y) * w + r.x) * 4;
    const d = y * row;
    for (let i = 0; i < row; i++) out[d + i] = data[s + i];
  }
}

function writeBlock(data: Uint8ClampedArray, w: number, r: Rect, src: Uint8ClampedArray): void {
  const row = r.w * 4;
  for (let y = 0; y < r.h; y++) {
    const d = ((r.y + y) * w + r.x) * 4;
    const s = y * row;
    for (let i = 0; i < row; i++) data[d + i] = src[s + i];
  }
}

/** 就地 Fisher-Yates，结果即 gather 映射 dst[i] ← src[a[i]] */
function shuffle(a: Uint32Array, n: number, rng: ChaCha20): void {
  for (let i = 0; i < n; i++) a[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = rng.below(i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}

/** 正向 gather / 逆向 scatter，scratch 与 buf 等长且用于暂存源数据 */
function applyGather(buf: Uint8ClampedArray, g: Uint32Array, n: number, inverse: boolean, scratch: Uint8ClampedArray): void {
  scratch.set(buf);
  for (let i = 0; i < n; i++) {
    const s = (inverse ? i : g[i]) * 4;
    const d = (inverse ? g[i] : i) * 4;
    buf[d] = scratch[s];
    buf[d + 1] = scratch[s + 1];
    buf[d + 2] = scratch[s + 2];
    buf[d + 3] = scratch[s + 3];
  }
}

/** 双面体群 D4 的 8 种变换：bit0=水平翻转(先)，bit1-2=旋转次数(90°CW) */
const dihedralCache = new Map<string, Uint32Array>();

function dihedralGather(n: number, t: number): Uint32Array {
  const key = `${n}:${t}`;
  const cached = dihedralCache.get(key);
  if (cached) return cached;
  const g = new Uint32Array(n * n);
  const flip = (t & 1) === 1;
  const rot = (t >> 1) & 3;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let nx = x;
      let ny = y;
      if (flip) nx = n - 1 - nx;
      for (let r = 0; r < rot; r++) {
        const tx = nx;
        nx = n - 1 - ny;
        ny = tx;
      }
      g[ny * n + nx] = y * n + x;
    }
  }
  dihedralCache.set(key, g);
  return g;
}

/** 就地反转 data 中 [from, to] 的元素（step 为相邻元素间隔，单位：分量） */
function reverseRun(d: Uint8ClampedArray, base: number, from: number, to: number, step: number): void {
  let a = from;
  let b = to;
  while (a < b) {
    const oa = base + a * step;
    const ob = base + b * step;
    for (let k = 0; k < 4; k++) {
      const t = d[oa + k];
      d[oa + k] = d[ob + k];
      d[ob + k] = t;
    }
    a++;
    b--;
  }
}

/**
 * 就地循环移位：元素向索引增大的方向移动 k 位（old[0] → new[k]）。
 * 三次反转实现，无需额外缓冲——原实现每行/每列各分配一个数组，单轮即产生数十 MB 垃圾。
 */
function shiftForward(d: Uint8ClampedArray, base: number, n: number, k: number, step: number): void {
  const s = ((k % n) + n) % n;
  if (s === 0 || n < 2) return;
  reverseRun(d, base, 0, n - 1, step);
  reverseRun(d, base, 0, s - 1, step);
  reverseRun(d, base, s, n - 1, step);
}

function channelPass(data: Uint8ClampedArray, w: number, rects: Rect[], rng: ChaCha20, inverse: boolean): void {
  const p = new Uint8Array(3);
  for (const r of rects) {
    p[0] = 0;
    p[1] = 1;
    p[2] = 2;
    for (let i = 2; i > 0; i--) {
      const j = rng.below(i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let y = 0; y < r.h; y++) {
      let idx = ((r.y + y) * w + r.x) * 4;
      for (let x = 0; x < r.w; x++, idx += 4) {
        const a = data[idx];
        const b = data[idx + 1];
        const c = data[idx + 2];
        if (!inverse) {
          data[idx] = p[0] === 0 ? a : p[0] === 1 ? b : c;
          data[idx + 1] = p[1] === 0 ? a : p[1] === 1 ? b : c;
          data[idx + 2] = p[2] === 0 ? a : p[2] === 1 ? b : c;
        } else {
          data[idx + p[0]] = a;
          data[idx + p[1]] = b;
          data[idx + p[2]] = c;
        }
      }
    }
  }
}

/** RGB 通道异或流：按行取流以复用行缓冲（流偏移与行内 RGB 字节序天然连续） */
function xorPass(data: Uint8ClampedArray, w: number, h: number, key: Uint8Array, nc: Uint8Array): void {
  const rowBytes = w * 3;
  const stream = new Uint8Array(rowBytes);
  const rng = new ChaCha20(key, nc);
  for (let y = 0; y < h; y++) {
    rng.streamInto(stream, y * rowBytes, rowBytes);
    let idx = y * w * 4;
    let s = 0;
    for (let x = 0; x < w; x++, idx += 4) {
      data[idx] ^= stream[s++];
      data[idx + 1] ^= stream[s++];
      data[idx + 2] ^= stream[s++];
    }
  }
}

/** 可逆加性噪声：delta ∈ [-amp, amp]，mod 256 精确可逆 */
function noisePass(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  key: Uint8Array,
  amp: number,
  inverse: boolean,
  nc: Uint8Array,
): void {
  if (amp <= 0) return;
  const range = 2 * amp + 1;
  const rowBytes = w * 3;
  const stream = new Uint8Array(rowBytes);
  const rng = new ChaCha20(key, nc);
  for (let y = 0; y < h; y++) {
    rng.streamInto(stream, y * rowBytes, rowBytes);
    let idx = y * w * 4;
    let s = 0;
    for (let x = 0; x < w; x++, idx += 4) {
      for (let comp = 0; comp < 3; comp++) {
        const delta = (stream[s++] % range) - amp;
        data[idx + comp] = inverse ? (data[idx + comp] - delta) & 0xff : (data[idx + comp] + delta) & 0xff;
      }
    }
  }
}

function intraPass(
  data: Uint8ClampedArray,
  w: number,
  layout: BlockLayout,
  b: BlockSize,
  rng: ChaCha20,
  inverse: boolean,
  ws: Workspace,
): void {
  for (const r of layout.rects) {
    if (r.w !== b || r.h !== b) continue; // 边缘非方块仅参与块间置换
    shuffle(ws.gather, b * b, rng);
    const flip = dihedralGather(b, rng.below(8));
    readBlock(data, w, r, ws.pixels);
    if (!inverse) {
      applyGather(ws.pixels, ws.gather, b * b, false, ws.stage);
      applyGather(ws.pixels, flip, b * b, false, ws.stage);
    } else {
      applyGather(ws.pixels, flip, b * b, true, ws.stage);
      applyGather(ws.pixels, ws.gather, b * b, true, ws.stage);
    }
    writeBlock(data, w, r, ws.pixels);
  }
}

/**
 * 块间置换：以环轮转就地搬运，只需 2 个块缓冲。
 * 正向 dst[k] ← src[g[k]]、逆向 dst[g[k]] ← src[k]，两者沿同一环链反向推进。
 */
function blockPermPass(
  data: Uint8ClampedArray,
  w: number,
  layout: BlockLayout,
  rng: ChaCha20,
  inverse: boolean,
  ws: Workspace,
): void {
  for (const idxs of layout.classes) {
    const n = idxs.length;
    if (n < 2) continue;
    const g = ws.gather;
    shuffle(g, n, rng);
    const seen = new Uint8Array(n);
    const held = ws.pixels;
    const temp = ws.stage;

    for (let start = 0; start < n; start++) {
      if (seen[start]) continue;
      // held 全程保存环起点内容：正向用作收口值，逆向用作沿链搬运的载荷
      readBlock(data, w, layout.rects[idxs[start]], held);
      let cur = start;
      seen[cur] = 1;
      for (;;) {
        const next = g[cur];
        if (inverse) {
          // dst[g[cur]] ← src[cur]：先取出 next 原内容，再把手上内容放入 next
          readBlock(data, w, layout.rects[idxs[next]], temp);
          writeBlock(data, w, layout.rects[idxs[next]], held);
          if (next === start) break;
          held.set(temp);
          cur = next;
          seen[cur] = 1;
        } else {
          // dst[cur] ← src[g[cur]]：cur 承接 next 的原内容
          if (next === start) {
            writeBlock(data, w, layout.rects[idxs[cur]], held);
            break;
          }
          readBlock(data, w, layout.rects[idxs[next]], temp);
          writeBlock(data, w, layout.rects[idxs[cur]], temp);
          cur = next;
          seen[cur] = 1;
        }
      }
    }
  }
}

/** 密钥化 S 盒字节替换（域 7，专业模式可叠加） */
function sboxPass(data: Uint8ClampedArray, key: Uint8Array, inverse: boolean, nc: Uint8Array): void {
  const rng = new ChaCha20(key, nc);
  const table = new Uint32Array(256);
  shuffle(table, 256, rng);
  if (inverse) {
    const inv = new Uint32Array(256);
    for (let i = 0; i < 256; i++) inv[table[i]] = i;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = inv[data[i]];
      data[i + 1] = inv[data[i + 1]];
      data[i + 2] = inv[data[i + 2]];
    }
    return;
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = table[data[i]];
    data[i + 1] = table[data[i + 1]];
    data[i + 2] = table[data[i + 2]];
  }
}

/** 密钥化行/列循环移位（域 8，专业模式可叠加），提升整体扩散性 */
function rowShiftPass(data: Uint8ClampedArray, w: number, h: number, key: Uint8Array, inverse: boolean, nc: Uint8Array): void {
  const rng = new ChaCha20(key, nc);
  const rowShifts = new Uint32Array(h);
  for (let y = 0; y < h; y++) rowShifts[y] = rng.below(w);
  const colShifts = new Uint32Array(w);
  for (let x = 0; x < w; x++) colShifts[x] = rng.below(h);

  if (!inverse) {
    for (let y = 0; y < h; y++) shiftForward(data, y * w * 4, w, rowShifts[y], 4);
    for (let x = 0; x < w; x++) shiftForward(data, x * 4, h, colShifts[x], w * 4);
    return;
  }
  for (let x = 0; x < w; x++) shiftForward(data, x * 4, h, h - colShifts[x], w * 4);
  for (let y = 0; y < h; y++) shiftForward(data, y * w * 4, w, w - rowShifts[y], 4);
}

/** 两级分块置换的块内像素数：块内置换与块间搬运都落在十几 KB 的窗口内，可命中缓存 */
const PERM_CHUNK = 4096;

/**
 * 全局像素置换（两级分块）。
 *
 * 先按整块置换（每块 PERM_CHUNK 个连续像素），再在每块内部独立置换；不足一块的余量单独成块。
 * 组合结果仍是均匀置换，但索引表由 O(n) 降为 O(√n) 量级（12MP 下 48MB → 数十 KB），
 * 且随机访问被限制在十几 KB 的窗口内——整表 Fisher-Yates 的开销正来自一遍 48MB 的随机读写。
 * 代价：像素位移不超过一个块的跨度。
 */
function chunkedPerm(src: Uint8ClampedArray, dst: Uint8ClampedArray, n: number, rng: ChaCha20, inverse: boolean): void {
  const chunk = Math.min(PERM_CHUNK, n);
  const full = Math.floor(n / chunk);
  const tail = n - full * chunk;

  const blocks = new Uint32Array(full);
  shuffle(blocks, full, rng);
  const map = new Uint32Array(chunk);

  for (let i = 0; i < full; i++) {
    shuffle(map, chunk, rng);
    const a = i * chunk;
    const b = blocks[i] * chunk;
    for (let k = 0; k < chunk; k++) {
      const s = (inverse ? a + k : b + map[k]) * 4;
      const d = (inverse ? b + map[k] : a + k) * 4;
      dst[d] = src[s];
      dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s + 2];
      dst[d + 3] = src[s + 3];
    }
  }

  if (tail > 0) {
    shuffle(map.subarray(0, tail), tail, rng);
    const a = full * chunk;
    for (let k = 0; k < tail; k++) {
      const s = (inverse ? a + k : a + map[k]) * 4;
      const d = (inverse ? a + map[k] : a + k) * 4;
      dst[d] = src[s];
      dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s + 2];
      dst[d + 3] = src[s + 3];
    }
  }
}

/** 全局像素置换：消除一切局部统计特征（专业模式） */
function globalPermPass(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  w: number,
  h: number,
  keys: SubKeys,
  iv: Uint8Array,
  inverse: boolean,
): void {
  chunkedPerm(src, dst, w * h, new ChaCha20(keys.perm, ivNonce(iv, DOM_GLOBAL_PERM)), inverse);
}

export interface ScrambleOptions {
  /** 变换轮数 1..MAX_ROUNDS，默认 1 */
  rounds?: number;
  /** 全局像素置换，默认 false */
  globalPerm?: boolean;
  /** S 盒字节替换，默认 false */
  sbox?: boolean;
  /** 行/列循环移位，默认 false */
  rowshift?: boolean;
}

interface Resolved {
  rounds: number;
  globalPerm: boolean;
  sbox: boolean;
  rowshift: boolean;
}

function resolve(opts: ScrambleOptions): Resolved {
  return {
    rounds: Math.min(Math.max(opts.rounds ?? 1, 1), MAX_ROUNDS),
    globalPerm: !!opts.globalPerm,
    sbox: !!opts.sbox,
    rowshift: !!opts.rowshift,
  };
}

/** 单轮变换；round 用于 nonce 域分离，保证各轮密钥流独立 */
function roundTransform(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  keys: SubKeys,
  layout: BlockLayout,
  b: BlockSize,
  amp: number,
  iv: Uint8Array,
  inverse: boolean,
  round: number,
  o: Resolved,
  ws: Workspace,
): void {
  const dom = round * 16;
  if (!inverse) {
    channelPass(data, w, layout.rects, new ChaCha20(keys.perm, ivNonce(iv, DOM_CHANNEL + dom)), false);
    xorPass(data, w, h, keys.xor, ivNonce(iv, DOM_XOR + dom));
    if (o.sbox) sboxPass(data, keys.xor, false, ivNonce(iv, DOM_SBOX + dom));
    noisePass(data, w, h, keys.noise, amp, false, ivNonce(iv, DOM_NOISE + dom));
    if (o.rowshift) rowShiftPass(data, w, h, keys.perm, false, ivNonce(iv, DOM_ROW_SHIFT + dom));
    intraPass(data, w, layout, b, new ChaCha20(keys.perm, ivNonce(iv, DOM_INTRA + dom)), false, ws);
    blockPermPass(data, w, layout, new ChaCha20(keys.perm, ivNonce(iv, DOM_BLOCK + dom)), false, ws);
    return;
  }
  blockPermPass(data, w, layout, new ChaCha20(keys.perm, ivNonce(iv, DOM_BLOCK + dom)), true, ws);
  intraPass(data, w, layout, b, new ChaCha20(keys.perm, ivNonce(iv, DOM_INTRA + dom)), true, ws);
  if (o.rowshift) rowShiftPass(data, w, h, keys.perm, true, ivNonce(iv, DOM_ROW_SHIFT + dom));
  noisePass(data, w, h, keys.noise, amp, true, ivNonce(iv, DOM_NOISE + dom));
  if (o.sbox) sboxPass(data, keys.xor, true, ivNonce(iv, DOM_SBOX + dom));
  xorPass(data, w, h, keys.xor, ivNonce(iv, DOM_XOR + dom));
  channelPass(data, w, layout.rects, new ChaCha20(keys.perm, ivNonce(iv, DOM_CHANNEL + dom)), true);
}

export function scrambleImage(
  src: Raster,
  keys: SubKeys,
  blockSize: BlockSize,
  noiseAmp: number,
  iv: Uint8Array,
  opts: ScrambleOptions = {},
): Raster {
  const o = resolve(opts);
  const { width: w, height: h } = src;
  const layout = blockLayout(w, h, blockSize);
  const ws = workspace(blockSize, layout.rects.length);
  let data = src.data.slice();
  for (let r = 0; r < o.rounds; r++) roundTransform(data, w, h, keys, layout, blockSize, noiseAmp, iv, false, r, o, ws);
  if (o.globalPerm) {
    const out = new Uint8ClampedArray(data.length);
    globalPermPass(data, out, w, h, keys, iv, false);
    data = out;
  }
  return { width: w, height: h, data };
}

export function unscrambleImage(
  src: Raster,
  keys: SubKeys,
  blockSize: BlockSize,
  noiseAmp: number,
  iv: Uint8Array,
  opts: ScrambleOptions = {},
): Raster {
  const o = resolve(opts);
  const { width: w, height: h } = src;
  const layout = blockLayout(w, h, blockSize);
  const ws = workspace(blockSize, layout.rects.length);
  let data = src.data.slice();
  if (o.globalPerm) {
    const out = new Uint8ClampedArray(data.length);
    globalPermPass(data, out, w, h, keys, iv, true);
    data = out;
  }
  for (let r = o.rounds - 1; r >= 0; r--) roundTransform(data, w, h, keys, layout, blockSize, noiseAmp, iv, true, r, o, ws);
  return { width: w, height: h, data };
}
