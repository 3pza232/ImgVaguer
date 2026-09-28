/**
 * 最小 PNG 编解码器（RGB8 / RGBA8，非隔行）+ 私有 ancillary chunk 读写。
 *
 * 编码启用自适应行滤波：PNG 的压缩能力主要来自把相邻像素差压成小值，
 * 不滤波等于浪费一半以上的压缩率。alpha 全图恒为 255 时按 RGB 编码省去 25% 数据，
 * 解码端补回 255，逐位等价。
 * 解码不依赖 canvas，保证密文像素逐位可校验。
 */
import { unzlibSync, zlibSync } from '../libs/fflate.js';
import type { Raster } from './types';

const SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** PNG 行滤波类型：None / Sub / Up / Average / Paeth */
const F_NONE = 0;
const F_SUB = 1;
const F_UP = 2;
const F_AVG = 3;
const F_PAETH = 4;
/** 行滤波打分采样数：全行打分在大图上过慢，等距抽样足以选出最优 */
const F_SAMPLES = 256;

/** zlib 压缩级别 */
export type CompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * 可压缩数据（自然图像、滤波扫描线）的压缩级别。
 * 滤波已承担主要压缩收益，1 级即可达 6 级 95% 的压缩率而快约 3.5 倍；
 * 纯 JS 熵编码是移动端加解密耗时的主要来源，故取曲线拐点。
 */
export const LEVEL_COMPRESSED: CompressionLevel = 1;
/** 不可压缩数据（密文像素）的压缩级别：跳过熵编码快一个数量级，体积几乎不变 */
export const LEVEL_RAW: CompressionLevel = 0;

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** alpha 是否全图恒为 255（绝大多数照片与截图成立） */
export function isOpaque(r: Raster): boolean {
  const d = r.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return false;
  return true;
}

/** 单通道残差：a/b/c 分别为左侧、上方、左上相邻样本，缺失处已置 0 */
function residual(f: number, x: number, a: number, b: number, c: number): number {
  switch (f) {
    case F_NONE: return x;
    case F_SUB: return (x - a) & 0xff;
    case F_UP: return (x - b) & 0xff;
    case F_AVG: return (x - ((a + b) >> 1)) & 0xff;
    default: return (x - paeth(a, b, c)) & 0xff;
  }
}

/**
 * 单行自适应滤波：抽样打分选出残差绝对值之和最小的滤波，再整行写出。
 * 与 unfilterScanlines 严格互逆：采样步长只影响压缩率，不影响可逆性。
 * @param prev 上一行源首字节偏移，-1 表示无上一行
 */
function filterRowInto(
  raw: Uint8Array,
  out: number,
  d: Uint8ClampedArray,
  src: number,
  prev: number,
  w: number,
  ch: number,
): void {
  const step = Math.max(1, Math.ceil(w / F_SAMPLES));
  let best = F_NONE;
  let bestScore = Infinity;
  for (let f = 0; f <= F_PAETH; f++) {
    let score = 0;
    for (let x = 0; x < w; x += step) {
      for (let c = 0; c < ch; c++) {
        const s = src + x * 4 + c;
        const v = residual(
          f, d[s],
          x > 0 ? d[s - 4] : 0,
          prev >= 0 ? d[prev + x * 4 + c] : 0,
          x > 0 && prev >= 0 ? d[prev + (x - 1) * 4 + c] : 0,
        );
        score += v < 128 ? v : 256 - v;
      }
    }
    if (score < bestScore) {
      bestScore = score;
      best = f;
    }
  }
  raw[out] = best;
  let o = out + 1;
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < ch; c++) {
      const s = src + x * 4 + c;
      raw[o++] = residual(
        best, d[s],
        x > 0 ? d[s - 4] : 0,
        prev >= 0 ? d[prev + x * 4 + c] : 0,
        x > 0 && prev >= 0 ? d[prev + (x - 1) * 4 + c] : 0,
      );
    }
  }
}

/**
 * 逐行自适应滤波为 PNG 扫描线（每行前置滤波类型字节）。
 * 加密载荷复用同一前处理，以取得与原图 PNG 相当的压缩率。
 * 位图始终为 RGBA，故源步长恒为 4 字节/像素，输出步长由 alpha 决定。
 * @param alpha 给定则按 RGB 编码（alpha 恒为该值），否则 RGBA
 */
export function filterScanlines(r: Raster, alpha?: number): Uint8Array {
  const ch = alpha === undefined ? 4 : 3;
  const srcStride = r.width * 4;
  const outStride = r.width * ch;
  const raw = new Uint8Array((outStride + 1) * r.height);
  for (let y = 0; y < r.height; y++) {
    const src = y * srcStride;
    filterRowInto(raw, y * (outStride + 1), r.data, src, y > 0 ? src - srcStride : -1, r.width, ch);
  }
  return raw;
}

/**
 * filterScanlines 的逆操作。通道数由扫描线长度唯一确定（3 或 4 字节/像素），
 * 故载荷无需额外记录 alpha；RGB 解码时补回 alpha=255。
 */
export function unfilterScanlines(raw: Uint8Array, width: number, height: number): Raster {
  const ch = (width * 3 + 1) * height === raw.length ? 3 : (width * 4 + 1) * height === raw.length ? 4 : 0;
  if (!ch) throw new Error('扫描线长度与图像尺寸不匹配');
  const data = new Uint8ClampedArray(width * height * 4);
  const rowOut = width * 4;
  let so = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[so++];
    const o = y * rowOut;
    const po = o - rowOut;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < ch; c++) {
        const di = o + x * 4 + c;
        const cur = raw[so++];
        const a = x > 0 ? data[di - 4] : 0;
        const b = y > 0 ? data[po + x * 4 + c] : 0;
        const cc = x > 0 && y > 0 ? data[po + (x - 1) * 4 + c] : 0;
        let v: number;
        switch (ft) {
          case F_NONE: v = cur; break;
          case F_SUB: v = cur + a; break;
          case F_UP: v = cur + b; break;
          case F_AVG: v = cur + ((a + b) >> 1); break;
          case F_PAETH: v = cur + paeth(a, b, cc); break;
          default: throw new Error('未知的 PNG 行滤波类型');
        }
        data[di] = v & 0xff;
      }
      if (ch === 3) data[o + x * 4 + 3] = 255;
    }
  }
  return { width, height, data };
}

export interface PngOptions {
  /** 附加私有 ancillary chunk */
  extra?: { type: string; data: Uint8Array };
  /** zlib 压缩级别，默认 LEVEL_COMPRESSED；密文像素等不可压缩数据传 LEVEL_RAW */
  level?: CompressionLevel;
}

/** 编码为 PNG。alpha 全图恒为 255 时自动按 RGB 编码（解码端补回 255，逐位等价）。 */
export function encodePng(r: Raster, opts: PngOptions = {}): Uint8Array {
  const { width: w, height: h } = r;
  const alpha = isOpaque(r) ? 255 : undefined;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;                            // bit depth
  ihdr[9] = alpha === undefined ? 6 : 2;  // color type: RGBA / RGB
  const idat = zlibSync(filterScanlines(r, alpha), { level: opts.level ?? LEVEL_COMPRESSED });

  const parts: Uint8Array[] = [SIG, chunk('IHDR', ihdr)];
  if (opts.extra) parts.push(chunk(opts.extra.type, opts.extra.data));
  parts.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return false;
  return true;
}

interface PngChunk {
  type: string;
  data: Uint8Array;
}

/** 顺序遍历 PNG chunk；遇到 IEND 或数据截断即停（不抛错，由调用方按需校验） */
function* walkChunks(bytes: Uint8Array): Generator<PngChunk> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8;
  while (o + 8 <= bytes.length) {
    const len = dv.getUint32(o);
    if (o + 12 + len > bytes.length) return;
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    yield { type, data: bytes.subarray(o + 8, o + 8 + len) };
    o += 12 + len;
    if (type === 'IEND') return;
  }
}

export function extractPngChunk(bytes: Uint8Array, type: string): Uint8Array | null {
  if (!isPng(bytes)) return null;
  for (const c of walkChunks(bytes)) if (c.type === type) return c.data;
  return null;
}

/**
 * 解码 PNG（RGB8 / RGBA8、非隔行）为 RGBA Raster。
 * 仅支持本工具写出的编码形态；5 种行滤波均支持以保证对同类文件的鲁棒性，
 * 调色板 / 隔行 / 16 位等一律拒绝。
 */
export function decodePngRgba(bytes: Uint8Array): Raster {
  if (!isPng(bytes)) throw new Error('非法的 PNG 文件');

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  let idatLen = 0;
  for (const c of walkChunks(bytes)) {
    if (c.type === 'IHDR') {
      if (c.data.length < 13) throw new Error('PNG 的 IHDR 长度非法');
      const dv = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      const bitDepth = c.data[8];
      const colorType = c.data[9];
      const interlace = c.data[12];
      if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
        throw new Error('不支持的 PNG 编码（需 RGB8/RGBA8、非隔行）');
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (c.type === 'IDAT') {
      idat.push(c.data.slice());
      idatLen += c.data.length;
    } else if (c.type === 'IEND') {
      break;
    }
  }
  if (!width || !height) throw new Error('PNG 缺少 IHDR');
  if (!idatLen) throw new Error('PNG 缺少 IDAT');

  const compressed = new Uint8Array(idatLen);
  let co = 0;
  for (const part of idat) { compressed.set(part, co); co += part.length; }
  const raw = unzlibSync(compressed);
  if (raw.length !== (width * channels + 1) * height) throw new Error('PNG 像素数据长度不匹配');
  return unfilterScanlines(raw, width, height);
}
