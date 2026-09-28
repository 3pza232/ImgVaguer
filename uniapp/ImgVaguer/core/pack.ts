/**
 * 多文件容器：把若干原始文件装入二进制容器，服务于「多图合并」与「原始文件字节」载荷。
 *
 *   magic "IVPK"(4) | count(4 LE)
 *   每项: nameLen(2 LE) | name(UTF-8) | dataLen(4 LE) | data（原始文件字节）
 *
 * 单图与多图共用同一容器：单图即 count = 1，读取端无需分支。
 * 文件名用自带的 UTF-8 编解码，不依赖 TextEncoder / TextDecoder——
 * 容器层为两端同源代码，而 App（5+）与部分小程序 runtime 不提供这两个全局。
 */
import { utf8Decode, utf8Encode } from './text';
import type { Raster } from './types';

const MAGIC = Uint8Array.from([0x49, 0x56, 0x50, 0x4b]); // "IVPK"

export interface DecodedImage {
  name: string;
  /** 原始文件字节 */
  bytes?: Uint8Array;
  /** 位图（像素级布局还原所得） */
  raster?: Raster;
}

/** 待打包的原始文件 */
export interface RawFile {
  name: string;
  bytes: Uint8Array;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function packFiles(files: RawFile[]): Uint8Array {
  if (!files.length) throw new Error('没有可打包的文件');
  const head = new Uint8Array(8);
  head.set(MAGIC, 0);
  new DataView(head.buffer).setUint32(4, files.length, true);

  const parts: Uint8Array[] = [head];
  for (const f of files) {
    const nb = utf8Encode(f.name);
    const meta = new Uint8Array(2 + nb.length + 4);
    const dv = new DataView(meta.buffer);
    dv.setUint16(0, nb.length, true);
    meta.set(nb, 2);
    dv.setUint32(2 + nb.length, f.bytes.length, true);
    parts.push(meta, f.bytes);
  }
  return concat(parts);
}

export function unpackImages(bytes: Uint8Array): DecodedImage[] {
  if (bytes.length < 8) throw new Error('文件容器被截断');
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new Error('文件容器标识非法');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(4, true);
  const out: DecodedImage[] = [];
  let o = 8;

  for (let i = 0; i < count; i++) {
    if (o + 2 > bytes.length) throw new Error('文件容器被截断');
    const nameLen = dv.getUint16(o, true); o += 2;
    if (o + nameLen > bytes.length) throw new Error('文件容器被截断');
    const name = utf8Decode(bytes.subarray(o, o + nameLen)); o += nameLen;
    if (o + 4 > bytes.length) throw new Error('文件容器被截断');
    const len = dv.getUint32(o, true); o += 4;
    if (o + len > bytes.length) throw new Error('文件容器数据非法');
    out.push({ name, bytes: bytes.slice(o, o + len) });
    o += len;
  }
  return out;
}
