/**
 * ImgVaguer 数据块（私有 ancillary chunk）wire 格式。
 *
 * 公开前导（可被任何人读取，用于引导密钥派生）：
 *   version(1) | salt(16) | iterations(4 LE) | seed(32)
 * 之后是加密元数据与 HMAC：
 *   metaCipher(变长) | mac(32)
 *
 * 除前导外**不暴露任何品牌标识或明文参数**：模式、保护方式、分块/噪声、
 * 原图尺寸、参数载荷全部在 metaCipher 内（用 'meta' 子密钥加密）。
 * 是否为本工具产物由 chunk 类型判定；解密内容由内部魔数（META_MAGIC）校验。
 *
 * seed 恒为 32B 随机：none 模式下即主密钥材料，其余模式下为等长诱饵，
 * 使三种保护方式在公开字段上不可区分。
 */
import type { Mode, Protection } from './types';

/** 私有 ancillary chunk 类型（去品牌化命名，仍符合 PNG 命名规范） */
export const CHUNK_TYPE = 'inVa';
export const VERSION = 3;
export const HMAC_LEN = 32;

export const SALT_LEN = 16;
export const SEED_LEN = 32;
/** version(1) + salt(16) + iterations(4) + seed(32) */
export const PREAMBLE_LEN = 1 + SALT_LEN + 4 + SEED_LEN;

const META_MAGIC = Uint8Array.from([0x49, 0x56, 0x47, 0x4d, 0x45, 0x54, 0x41, 0x33]); // "IVGMETA3"
/** magic(8) + mode(1) + protection(1) + p1(1) + p2(1) + w(4) + h(4) + payloadLen(4) */
const META_FIXED = META_MAGIC.length + 1 + 1 + 1 + 1 + 4 + 4 + 4;

const PROT_CODE: Record<Protection, number> = { none: 0, password: 1, keyfile: 2 };
const PROT_FROM: readonly Protection[] = ['none', 'password', 'keyfile'];

/** 解密后可得的明文元数据 */
export interface MetaFields {
  mode: Mode;
  /** 多图合并标志（仅密钥文件保护下由本工具产生） */
  pack: boolean;
  protection: Protection;
  /** scramble: blockSize / overlay: opacity% */
  p1: number;
  /** scramble: noise / overlay: fit */
  p2: number;
  origWidth: number;
  origHeight: number;
}

export interface ParsedChunk {
  version: number;
  salt: Uint8Array;
  iterations: number;
  seed: Uint8Array;
  metaCipher: Uint8Array;
  mac: Uint8Array;
  /** version||salt||iterations||seed，参与 HMAC，不含 metaCipher 与 mac */
  preamble: Uint8Array;
}

export function buildPreamble(
  version: number,
  salt: Uint8Array,
  iterations: number,
  seed: Uint8Array,
): Uint8Array {
  if (salt.length !== SALT_LEN || seed.length !== SEED_LEN) throw new Error('salt/seed 长度非法');
  const out = new Uint8Array(PREAMBLE_LEN);
  const dv = new DataView(out.buffer);
  out[0] = version;
  out.set(salt, 1);
  dv.setUint32(1 + SALT_LEN, iterations >>> 0, true);
  out.set(seed, 1 + SALT_LEN + 4);
  return out;
}

export function buildChunk(preamble: Uint8Array, metaCipher: Uint8Array, mac: Uint8Array): Uint8Array {
  const out = new Uint8Array(preamble.length + metaCipher.length + mac.length);
  out.set(preamble, 0);
  out.set(metaCipher, preamble.length);
  out.set(mac, preamble.length + metaCipher.length);
  return out;
}

export function parseChunk(buf: Uint8Array): ParsedChunk {
  if (buf.length < PREAMBLE_LEN + HMAC_LEN) throw new Error('数据块被截断');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    version: buf[0],
    salt: buf.slice(1, 1 + SALT_LEN),
    iterations: dv.getUint32(1 + SALT_LEN, true),
    seed: buf.slice(1 + SALT_LEN + 4, PREAMBLE_LEN),
    metaCipher: buf.subarray(PREAMBLE_LEN, buf.length - HMAC_LEN),
    mac: buf.subarray(buf.length - HMAC_LEN),
    preamble: buf.subarray(0, PREAMBLE_LEN),
  };
}

/** 序列化明文元数据（供加密前使用），payload 追加在其后 */
export function buildMeta(f: MetaFields, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(META_FIXED + payload.length);
  const dv = new DataView(out.buffer);
  out.set(META_MAGIC, 0);
  let o = META_MAGIC.length;
  // mode 低比特：0=scramble 1=overlay；bit1：pack
  out[o++] = (f.mode === 'scramble' ? 0 : 1) | (f.pack ? 2 : 0);
  out[o++] = PROT_CODE[f.protection];
  out[o++] = f.p1 & 0xff;
  out[o++] = f.p2 & 0xff;
  dv.setUint32(o, f.origWidth, true); o += 4;
  dv.setUint32(o, f.origHeight, true); o += 4;
  dv.setUint32(o, payload.length, true); o += 4;
  out.set(payload, o);
  return out;
}

/** 轻量校验：仅判断内部魔数，用于候选密钥筛选 */
export function hasMetaMagic(buf: Uint8Array): boolean {
  if (buf.length < META_MAGIC.length) return false;
  for (let i = 0; i < META_MAGIC.length; i++) if (buf[i] !== META_MAGIC[i]) return false;
  return true;
}

export function parseMeta(buf: Uint8Array): { fields: MetaFields; payload: Uint8Array } {
  if (!hasMetaMagic(buf) || buf.length < META_FIXED) throw new Error('元数据无效');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = META_MAGIC.length;
  const modeCode = buf[o++];
  const mode: Mode = (modeCode & 1) === 1 ? 'overlay' : 'scramble';
  const pack = (modeCode & 2) !== 0;
  const protection = PROT_FROM[buf[o++]] ?? 'none';
  const p1 = buf[o++];
  const p2 = buf[o++];
  const origWidth = dv.getUint32(o, true); o += 4;
  const origHeight = dv.getUint32(o, true); o += 4;
  const payloadLen = dv.getUint32(o, true); o += 4;
  if (o + payloadLen > buf.length) throw new Error('元数据被截断');
  return {
    fields: { mode, pack, protection, p1, p2, origWidth, origHeight },
    payload: buf.slice(o, o + payloadLen),
  };
}
