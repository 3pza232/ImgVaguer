/**
 * 密文混淆：全可逆像素级变换管线。
 * 正向：通道置换 → 异或流 → 加性噪声 → 块内像素置换+双面体变换 → 块间置换
 * 逆向：严格镜像执行。所有随机性来自 ChaCha20 密钥流，双射保证逐位还原。
 */
import { chacha20Block, chacha20StreamAt } from './chacha';
import type { SubKeys } from './kdf';
import type { Raster } from './types';

export type BlockSize = 8 | 16 | 32;

function nonce(domain: number): Uint8Array {
  const n = new Uint8Array(12);
  n[0] = domain;
  return n;
}

/** 基于密钥流的均匀抽样 reader，支持拒绝采样消除模偏 */
class KeyedReader {
  private buf = new Uint8Array(0);
  private pos = 0;
  private counter = 0;

  constructor(private key: Uint8Array, private nc: Uint8Array) {}

  private ensure(bytes: number): void {
    if (this.buf.length - this.pos >= bytes) return;
    const rest = this.buf.subarray(this.pos);
    const next = new Uint8Array(rest.length + 64);
    next.set(rest);
    next.set(chacha20Block(this.key, this.counter, this.nc), rest.length);
    this.counter = (this.counter + 1) >>> 0;
    this.buf = next;
    this.pos = 0;
  }

  u32(): number {
    this.ensure(4);
    const b = this.buf;
    const v = (b[this.pos] | (b[this.pos + 1] << 8) | (b[this.pos + 2] << 16) | (b[this.pos + 3] << 24)) >>> 0;
    this.pos += 4;
    return v;
  }

  /** [0, n) 均匀分布 */
  below(n: number): number {
    if (n <= 1) return 0;
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) {
      const x = this.u32();
      if (x < limit) return x % n;
    }
  }
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function blockRects(w: number, h: number, b: number): Rect[] {
  const out: Rect[] = [];
  for (let y = 0; y < h; y += b) {
    for (let x = 0; x < w; x += b) {
      out.push({ x, y, w: Math.min(b, w - x), h: Math.min(b, h - y) });
    }
  }
  return out;
}

/** Fisher-Yates，返回 gather 映射：dst[i] <- src[g[i]] */
function shuffleGather(n: number, rd: KeyedReader): Uint32Array {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = rd.below(i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function readBlock(data: Uint8ClampedArray, w: number, r: Rect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const s = ((r.y + y) * w + r.x) * 4;
    out.set(data.subarray(s, s + r.w * 4), y * r.w * 4);
  }
  return out;
}

function writeBlock(data: Uint8ClampedArray, w: number, r: Rect, block: Uint8ClampedArray): void {
  for (let y = 0; y < r.h; y++) {
    const d = ((r.y + y) * w + r.x) * 4;
    data.set(block.subarray(y * r.w * 4, (y + 1) * r.w * 4), d);
  }
}

/** 正向 gather / 逆向 scatter */
function applyGather(buf: Uint8ClampedArray, g: Uint32Array, inverse: boolean): void {
  const src = buf.slice();
  for (let i = 0; i < g.length; i++) {
    const s = (inverse ? i : g[i]) * 4;
    const d = (inverse ? g[i] : i) * 4;
    buf[d] = src[s];
    buf[d + 1] = src[s + 1];
    buf[d + 2] = src[s + 2];
    buf[d + 3] = src[s + 3];
  }
}

/** 双面体群 D4 的 8 种变换：t bit0=水平翻转(先)，bit1-2=旋转次数(90°CW) */
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

function channelPass(data: Uint8ClampedArray, w: number, rects: Rect[], rd: KeyedReader, inverse: boolean): void {
  for (const r of rects) {
    const p = shuffleGather(3, rd);
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

/** RGB 通道异或流，按行分块取流以控制内存 */
function xorPass(data: Uint8ClampedArray, w: number, h: number, key: Uint8Array, nc: Uint8Array): void {
  const rowBytes = w * 3;
  for (let y = 0; y < h; y++) {
    const stream = chacha20StreamAt(key, nc, y * rowBytes, rowBytes);
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
function noisePass(data: Uint8ClampedArray, w: number, h: number, key: Uint8Array, amp: number, inverse: boolean, nc: Uint8Array): void {
  if (amp <= 0) return;
  const range = 2 * amp + 1;
  const rowBytes = w * 3;
  for (let y = 0; y < h; y++) {
    const stream = chacha20StreamAt(key, nc, y * rowBytes, rowBytes);
    let idx = y * w * 4;
    let s = 0;
    for (let x = 0; x < w; x++, idx += 4) {
      for (let c = 0; c < 3; c++) {
        const delta = (stream[s++] % range) - amp;
        data[idx + c] = inverse ? (data[idx + c] - delta) & 0xff : (data[idx + c] + delta) & 0xff;
      }
    }
  }
}

function intraPass(
  data: Uint8ClampedArray,
  w: number,
  rects: Rect[],
  b: BlockSize,
  rd: KeyedReader,
  inverse: boolean,
): void {
  for (const r of rects) {
    if (r.w !== b || r.h !== b) continue; // 边缘非方块仅参与块间置换
    const g1 = shuffleGather(b * b, rd);
    const g2 = dihedralGather(b, rd.below(8));
    const block = readBlock(data, w, r);
    if (!inverse) {
      applyGather(block, g1, false);
      applyGather(block, g2, false);
    } else {
      applyGather(block, g2, true);
      applyGather(block, g1, true);
    }
    writeBlock(data, w, r, block);
  }
}

/** 块间置换：仅在尺寸相同的块类别内置换，保证矩形可搬运 */
function blockPermPass(data: Uint8ClampedArray, w: number, rects: Rect[], rd: KeyedReader, inverse: boolean): void {
  const classes = new Map<string, number[]>();
  rects.forEach((r, i) => {
    const k = `${r.w}x${r.h}`;
    const arr = classes.get(k);
    if (arr) arr.push(i);
    else classes.set(k, [i]);
  });
  for (const idxs of classes.values()) {
    const g = shuffleGather(idxs.length, rd);
    const copies = idxs.map((i) => readBlock(data, w, rects[i]));
    for (let k = 0; k < idxs.length; k++) {
      const dstIdx = inverse ? idxs[g[k]] : idxs[k];
      const srcCopy = inverse ? copies[k] : copies[g[k]];
      writeBlock(data, w, rects[dstIdx], srcCopy);
    }
  }
}

/** 密钥化 S 盒字节替换（域 7，专业模式可叠加） */
function sboxPass(data: Uint8ClampedArray, key: Uint8Array, inverse: boolean, nc: Uint8Array): void {
  const rd = new KeyedReader(key, nc);
  const s = shuffleGather(256, rd);
  let table = s;
  if (inverse) {
    const inv = new Uint32Array(256);
    for (let i = 0; i < 256; i++) inv[s[i]] = i;
    table = inv;
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = table[data[i]];
    data[i + 1] = table[data[i + 1]];
    data[i + 2] = table[data[i + 2]];
  }
}

/** 密钥化行/列循环移位（域 8，专业模式可叠加），提升整体扩散性 */
function rowShiftPass(data: Uint8ClampedArray, w: number, h: number, key: Uint8Array, inverse: boolean, nc: Uint8Array): void {
  const rd = new KeyedReader(key, nc);
  const rowShifts = new Uint32Array(h);
  for (let y = 0; y < h; y++) rowShifts[y] = rd.below(w);
  const colShifts = new Uint32Array(w);
  for (let x = 0; x < w; x++) colShifts[x] = rd.below(h);

  const rotateRow = (y: number, s: number): void => {
    s %= w;
    if (s === 0) return;
    const base = y * w * 4;
    const row = data.slice(base, base + w * 4);
    for (let x = 0; x < w; x++) {
      const d = base + ((x + s) % w) * 4;
      const o = x * 4;
      data[d] = row[o];
      data[d + 1] = row[o + 1];
      data[d + 2] = row[o + 2];
      data[d + 3] = row[o + 3];
    }
  };
  const rotateCol = (x: number, s: number): void => {
    s %= h;
    if (s === 0) return;
    const col = new Uint8ClampedArray(h * 4);
    for (let y = 0; y < h; y++) {
      const o = (y * w + x) * 4;
      col[y * 4] = data[o];
      col[y * 4 + 1] = data[o + 1];
      col[y * 4 + 2] = data[o + 2];
      col[y * 4 + 3] = data[o + 3];
    }
    for (let y = 0; y < h; y++) {
      const d = (((y + s) % h) * w + x) * 4;
      const o = y * 4;
      data[d] = col[o];
      data[d + 1] = col[o + 1];
      data[d + 2] = col[o + 2];
      data[d + 3] = col[o + 3];
    }
  };

  if (!inverse) {
    for (let y = 0; y < h; y++) rotateRow(y, rowShifts[y]);
    for (let x = 0; x < w; x++) rotateCol(x, colShifts[x]);
  } else {
    for (let x = 0; x < w; x++) rotateCol(x, colShifts[x] ? h - colShifts[x] : 0);
    for (let y = 0; y < h; y++) rotateRow(y, rowShifts[y] ? w - rowShifts[y] : 0);
  }
}

/** 单轮变换；round 用于 nonce 域分离，保证各轮密钥流独立 */
function roundTransform(
  src: Raster,
  keys: SubKeys,
  b: BlockSize,
  amp: number,
  inverse: boolean,
  round: number,
  opts: { sbox: boolean; rowshift: boolean },
): Raster {
  const data = src.data.slice();
  const rects = blockRects(src.width, src.height, b);
  const dom = round * 16;
  const rdChannel = new KeyedReader(keys.perm, nonce(1 + dom));
  const rdIntra = new KeyedReader(keys.perm, nonce(2 + dom));
  const rdBlock = new KeyedReader(keys.perm, nonce(3 + dom));
  if (!inverse) {
    channelPass(data, src.width, rects, rdChannel, false);
    xorPass(data, src.width, src.height, keys.xor, nonce(4 + dom));
    if (opts.sbox) sboxPass(data, keys.xor, false, nonce(7 + dom));
    noisePass(data, src.width, src.height, keys.noise, amp, false, nonce(5 + dom));
    if (opts.rowshift) rowShiftPass(data, src.width, src.height, keys.perm, false, nonce(8 + dom));
    intraPass(data, src.width, rects, b, rdIntra, false);
    blockPermPass(data, src.width, rects, rdBlock, false);
  } else {
    blockPermPass(data, src.width, rects, rdBlock, true);
    intraPass(data, src.width, rects, b, rdIntra, true);
    if (opts.rowshift) rowShiftPass(data, src.width, src.height, keys.perm, true, nonce(8 + dom));
    noisePass(data, src.width, src.height, keys.noise, amp, true, nonce(5 + dom));
    if (opts.sbox) sboxPass(data, keys.xor, true, nonce(7 + dom));
    xorPass(data, src.width, src.height, keys.xor, nonce(4 + dom));
    channelPass(data, src.width, rects, rdChannel, true);
  }
  return { width: src.width, height: src.height, data };
}

/** 全局像素置换：整图 keyed Fisher-Yates，消除一切局部统计特征（专业模式） */
function globalPermPass(src: Raster, keys: SubKeys, inverse: boolean): Raster {
  const data = src.data.slice();
  const rd = new KeyedReader(keys.perm, nonce(6));
  const g = shuffleGather(src.width * src.height, rd);
  applyGather(data, g, inverse);
  return { width: src.width, height: src.height, data };
}

export interface ScrambleOptions {
  /** 变换轮数 1..4，默认 1 */
  rounds?: number;
  /** 全局像素置换，默认 false */
  globalPerm?: boolean;
  /** S 盒字节替换，默认 false */
  sbox?: boolean;
  /** 行/列循环移位，默认 false */
  rowshift?: boolean;
}

const MAX_ROUNDS = 8;

export function scrambleImage(src: Raster, keys: SubKeys, blockSize: BlockSize, noiseAmp: number, opts: ScrambleOptions = {}): Raster {
  const rounds = Math.min(Math.max(opts.rounds ?? 1, 1), MAX_ROUNDS);
  const flags = { sbox: !!opts.sbox, rowshift: !!opts.rowshift };
  let cur = src;
  for (let r = 0; r < rounds; r++) cur = roundTransform(cur, keys, blockSize, noiseAmp, false, r, flags);
  if (opts.globalPerm) cur = globalPermPass(cur, keys, false);
  return cur;
}

export function unscrambleImage(src: Raster, keys: SubKeys, blockSize: BlockSize, noiseAmp: number, opts: ScrambleOptions = {}): Raster {
  const rounds = Math.min(Math.max(opts.rounds ?? 1, 1), MAX_ROUNDS);
  const flags = { sbox: !!opts.sbox, rowshift: !!opts.rowshift };
  let cur = src;
  if (opts.globalPerm) cur = globalPermPass(cur, keys, true);
  for (let r = rounds - 1; r >= 0; r--) cur = roundTransform(cur, keys, blockSize, noiseAmp, true, r, flags);
  return cur;
}
