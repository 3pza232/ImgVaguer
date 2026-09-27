/**
 * 最小 PNG 编码器（RGBA8 / filter 0）+ 私有 ancillary chunk 读写。
 * 元数据与加密载荷放在自定义 chunk 中，像素数据保持逐位无损。
 */
import { zlibSync } from 'fflate';
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

export function extractPngChunk(bytes: Uint8Array, type: string): Uint8Array | null {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8;
  while (o + 8 <= bytes.length) {
    const len = dv.getUint32(o);
    const t = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    if (t === type) return bytes.subarray(o + 8, o + 8 + len);
    o += 12 + len;
    if (t === 'IEND') break;
  }
  return null;
}
