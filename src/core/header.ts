/**
 * ImgVaguer 数据块（ivGr chunk）头部布局，定长 75B + HMAC 32B + payload：
 *   0  magic "IVGR"        4
 *   4  version             1
 *   5  mode (1=scramble 2=overlay) 1
 *   6  flags (bit0=口令)   1
 *   7  kdf iterations      4 LE
 *  11  p1 (blockSize / opacity%) 1
 *  12  p2 (noise / fit)    1
 *  13  reserved            2
 *  15  salt               16
 *  31  seed (无口令时)     32
 *  63  origWidth           4 LE
 *  67  origHeight          4 LE
 *  71  payloadLen          4 LE
 *  75  HMAC-SHA256        32  (覆盖 header||payload)
 */
import type { Mode, Protection } from './types';

const PROT_CODE: Record<Protection, number> = { none: 0, password: 1, keyfile: 2 };

function protectionFrom(code: number): Protection {
  return code === 1 ? 'password' : code === 2 ? 'keyfile' : 'none';
}

export const CHUNK_TYPE = 'ivGr';
export const VERSION = 1;
export const HEADER_LEN = 75;
export const HMAC_LEN = 32;

const MAGIC = [0x49, 0x56, 0x47, 0x52]; // "IVGR"

export interface HeaderFields {
  mode: Mode;
  protection: Protection;
  iterations: number;
  p1: number;
  p2: number;
  salt: Uint8Array;
  seed: Uint8Array;
  origWidth: number;
  origHeight: number;
  payloadLen: number;
}

export function buildHeader(f: HeaderFields): Uint8Array {
  if (f.salt.length !== 16 || f.seed.length !== 32) throw new Error('salt/seed 长度非法');
  const out = new Uint8Array(HEADER_LEN);
  const dv = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  out[5] = f.mode === 'scramble' ? 1 : 2;
  out[6] = PROT_CODE[f.protection];
  dv.setUint32(7, f.iterations, true);
  out[11] = f.p1 & 0xff;
  out[12] = f.p2 & 0xff;
  out.set(f.salt, 15);
  out.set(f.seed, 31);
  dv.setUint32(63, f.origWidth, true);
  dv.setUint32(67, f.origHeight, true);
  dv.setUint32(71, f.payloadLen, true);
  return out;
}

export function parseHeader(buf: Uint8Array): HeaderFields {
  if (buf.length < HEADER_LEN) throw new Error('数据块长度不足');
  for (let i = 0; i < 4; i++) if (buf[i] !== MAGIC[i]) throw new Error('非法的 ImgVaguer 数据块');
  if (buf[4] !== VERSION) throw new Error(`不支持的版本: ${buf[4]}`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const mode = buf[5] === 1 ? 'scramble' : buf[5] === 2 ? 'overlay' : null;
  if (!mode) throw new Error('未知模式');
  return {
    mode,
    protection: protectionFrom(buf[6] & 3),
    iterations: dv.getUint32(7, true),
    p1: buf[11],
    p2: buf[12],
    salt: buf.slice(15, 31),
    seed: buf.slice(31, 63),
    origWidth: dv.getUint32(63, true),
    origHeight: dv.getUint32(67, true),
    payloadLen: dv.getUint32(71, true),
  };
}
