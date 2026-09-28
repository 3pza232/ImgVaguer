/**
 * 最小 PNG 编解码器（RGBA8 / 非隔行）+ 私有 ancillary chunk 读写。
 * 元数据与加密载荷放在自定义 chunk 中，像素数据保持逐位无损。
 * 解码不依赖 canvas，保证密文像素逐位可校验。
 */
import { unzlibSync, zlibSync } from '../libs/fflate.js';
import type { Raster } from './types';

const SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

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

export function encodePng(r: Raster, extra?: { type: string; data: Uint8Array }): Uint8Array {
  const { width: w, height: h } = r;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA

  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw.set(r.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = zlibSync(raw, { level: 6 });

  const parts: Uint8Array[] = [SIG, chunk('IHDR', ihdr)];
  if (extra) parts.push(chunk(extra.type, extra.data));
  parts.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
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

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * 解码 PNG（RGBA8 / 非隔行）为 Raster。
 * 仅支持本工具写出的编码形态（color type 6、bit depth 8、非隔行），
 * 覆盖全部 5 种行滤波以保证对同类文件的鲁棒性；JPEG/调色板等一律拒绝。
 */
export function decodePngRgba(bytes: Uint8Array): Raster {
  if (!isPng(bytes)) throw new Error('非法的 PNG 文件');

  let width = 0;
  let height = 0;
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
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error('不支持的 PNG 编码（需 RGBA8、非隔行）');
      }
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

  const stride = width * 4;
  if (raw.length !== (stride + 1) * height) throw new Error('PNG 像素数据长度不匹配');
  const data = new Uint8ClampedArray(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[src + x];
      const a = x >= 4 ? data[dst + x - 4] : 0;
      const b = y > 0 ? data[prev + x] : 0;
      const c = x >= 4 && y > 0 ? data[prev + x - 4] : 0;
      let v: number;
      switch (ft) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: v = cur + paeth(a, b, c); break;
        default: throw new Error('未知的 PNG 行滤波类型');
      }
      data[dst + x] = v & 0xff;
    }
  }
  return { width, height, data };
}
