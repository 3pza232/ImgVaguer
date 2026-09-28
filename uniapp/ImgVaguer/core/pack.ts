/**
 * 多图打包：把若干 Raster 无损装入二进制容器，用于「多图合并为一张」。
 * 容器结构（压缩与加密由 engine 负责）：
 *   magic "IVPK"(4) | count(4 LE)
 *   每图： nameLen(2 LE) | name(UTF-8) | width(4 LE) | height(4 LE) | RGBA 像素
 */
import { utf8Decode, utf8Encode } from './text';
import type { Raster } from './types';

const MAGIC = Uint8Array.from([0x49, 0x56, 0x50, 0x4b]); // "IVPK"

export interface DecodedImage {
  name: string;
  raster: Raster;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function packImages(images: DecodedImage[]): Uint8Array {
  if (!images.length) throw new Error('没有可打包的图像');
  const head = new Uint8Array(8);
  head.set(MAGIC, 0);
  new DataView(head.buffer).setUint32(4, images.length, true);
  const parts: Uint8Array[] = [head];
  for (const { name, raster } of images) {
    const nb = utf8Encode(name);
    const meta = new Uint8Array(2 + nb.length + 8);
    const dv = new DataView(meta.buffer);
    dv.setUint16(0, nb.length, true);
    meta.set(nb, 2);
    dv.setUint32(2 + nb.length, raster.width, true);
    dv.setUint32(6 + nb.length, raster.height, true);
    parts.push(meta, new Uint8Array(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength));
  }
  return concat(parts);
}

export function unpackImages(bytes: Uint8Array): DecodedImage[] {
  if (bytes.length < 8) throw new Error('图像容器被截断');
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new Error('图像容器标识非法');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(4, true);
  const out: DecodedImage[] = [];
  let o = 8;
  for (let i = 0; i < count; i++) {
    if (o + 2 > bytes.length) throw new Error('图像容器被截断');
    const nameLen = dv.getUint16(o, true); o += 2;
    if (o + nameLen + 8 > bytes.length) throw new Error('图像容器被截断');
    const name = utf8Decode(bytes.subarray(o, o + nameLen)); o += nameLen;
    const width = dv.getUint32(o, true); o += 4;
    const height = dv.getUint32(o, true); o += 4;
    const size = width * height * 4;
    if (!width || !height || o + size > bytes.length) throw new Error('图像容器像素数据非法');
    out.push({
      name,
      raster: { width, height, data: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + o, size).slice() },
    });
    o += size;
  }
  return out;
}
