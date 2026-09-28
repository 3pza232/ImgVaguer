/**
 * 编排层：密钥调度 + 模式分发 + 数据块封装。
 * DOM 无关，encrypt/decrypt 均可在 worker 或测试中运行。
 *
 * 保护方式（公开字段刻意不可区分）：
 *  - none     随机种子内嵌头部，持图即可还原
 *  - password PBKDF2(口令, salt)
 *  - keyfile  PBKDF2(外部 32B 密钥种子, salt)
 * 三者统一为「字节凭据 → PBKDF2 → 主密钥」；模式/保护方式等元数据加密存放。
 * 多图合并（pack）把整批原图装入加密载荷，输出单张图，三种保护方式均可用。
 */
import { chacha20Xor, IV_LEN, ivNonce } from '@/core/chacha';
import {
  buildChunk,
  buildMeta,
  buildPreamble,
  CHUNK_TYPE,
  hasMetaMagic,
  parseChunk,
  parseMeta,
  VERSION,
  type MetaFields,
} from '@/core/header';
import { deriveMasterKey, deriveSubKeys, hmacSha256, passwordBytes, timingSafeEqual, type SubKeys } from '@/core/kdf';
import { compositeLayers } from '@/core/overlay';
import { packImages, unpackImages, type DecodedImage } from '@/core/pack';
import { decodePngRgba, encodePng, extractPngChunk } from '@/core/png';
import { scrambleImage, unscrambleImage, type BlockSize, type ScrambleOptions } from '@/core/scramble';
import { utf8Decode, utf8Encode } from '@/core/text';
import { randomBytes } from '@/core/random';
import type { ImgVaguerParams, Protection, Raster } from '@/core/types';
import { unzlibSync, zlibSync } from '../libs/fflate.js';

const OVERLAY_DOMAIN = 0;
const META_DOMAIN = 200;
const BLOCK_SIZES: readonly number[] = [8, 16, 32];
const MIN_ITERATIONS = 1;
const MAX_ITERATIONS = 10_000_000;

export type { DecodedImage };

export interface EncryptOutput {
  bytes: Uint8Array;
  outRaster: Raster;
  fields: MetaFields;
}

/** 详情日志回调：向调用方（终端"详情"视图）输出内部步骤/参数 */
export type Trace = (line: string) => void;

function hex(bytes: Uint8Array, max = 12): string {
  const head = [...bytes.subarray(0, max)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return bytes.length > max ? `${head}…` : head;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Uint8ClampedArray 的字节视图（无拷贝） */
function asBytes(a: Uint8ClampedArray): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

async function deriveKeys(
  protection: Protection,
  password: string,
  extSeed: Uint8Array | undefined,
  seed: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Promise<SubKeys> {
  let credential: Uint8Array;
  if (protection === 'password') {
    credential = passwordBytes(password);
  } else if (protection === 'keyfile') {
    if (!extSeed || extSeed.length !== 32) throw new Error('缺少密钥种子');
    credential = extSeed;
  } else {
    credential = seed;
  }
  return deriveSubKeys(await deriveMasterKey(credential, salt, iterations));
}

/** 元数据加密 + HMAC + PNG 封装（单图与合并共用） */
async function seal(
  outRaster: Raster,
  payload: Uint8Array,
  fields: MetaFields,
  iterations: number,
  keys: SubKeys,
  salt: Uint8Array,
  seed: Uint8Array,
  iv: Uint8Array,
  trace?: Trace,
): Promise<Uint8Array> {
  const metaCipher = buildMeta(fields, payload);
  trace?.(`[meta] 明文 ${metaCipher.length}B -> ChaCha20 加密`);
  chacha20Xor(keys.meta, ivNonce(iv, META_DOMAIN), metaCipher);

  const preamble = buildPreamble(VERSION, salt, iterations, seed);
  const mac = await hmacSha256(keys.mac, concat(preamble, metaCipher, asBytes(outRaster.data)));
  const bytes = encodePng(outRaster, { type: CHUNK_TYPE, data: buildChunk(preamble, metaCipher, mac) });
  trace?.(`[mac] HMAC-SHA256 over preamble||meta||cipher(${outRaster.data.length}B)`);
  trace?.(`[out] ${outRaster.width}x${outRaster.height} PNG ${(bytes.length / 1024).toFixed(1)}KB chunk=${preamble.length + metaCipher.length + mac.length}B`);
  return bytes;
}

/**
 * 单图加密。
 * @param covers 覆盖图层（已缩放至目标尺寸），按叠放顺序排列
 * @param extSeed keyfile 模式下由调用方生成的 32B 密钥种子
 */
export async function encryptImage(
  target: Raster,
  params: ImgVaguerParams,
  covers: Raster[] = [],
  extSeed?: Uint8Array,
  trace?: Trace,
): Promise<EncryptOutput> {
  validateIterations(params.iterations);
  const salt = randomBytes(16);
  const seed = randomBytes(32); // none 即主密钥材料，其余为诱饵
  const iv = salt.subarray(0, IV_LEN);

  trace?.(`[key] PBKDF2-SHA256 iterations=${params.iterations} salt=${hex(salt)}`);
  const keys = await deriveKeys(params.protection, params.password, extSeed, seed, salt, params.iterations);
  trace?.(`[key] IV=${hex(iv)} 子密钥=perm/xor/noise/mac/overlay/meta`);

  let outRaster: Raster;
  let payload = new Uint8Array(0);
  let p1 = 0;
  let p2 = 0;

  if (params.mode === 'scramble') {
    const opts: ScrambleOptions = {
      rounds: params.rounds ?? 1,
      globalPerm: params.globalPerm ?? false,
      sbox: params.sbox ?? false,
      rowshift: params.rowshift ?? false,
    };
    trace?.(`[cipher] 管线 x${opts.rounds} @block${params.blockSize}: ${describePipeline(params.noise, opts)}`);
    outRaster = scrambleImage(target, keys, params.blockSize, params.noise, iv, opts);
    if (opts.rounds! > 1 || opts.globalPerm || opts.sbox || opts.rowshift) {
      payload = utf8Encode(JSON.stringify({
        r: opts.rounds,
        g: opts.globalPerm ? 1 : 0,
        s: opts.sbox ? 1 : 0,
        rs: opts.rowshift ? 1 : 0,
      }));
    }
    p1 = params.blockSize;
    p2 = params.noise;
  } else {
    if (!covers.length) throw new Error('需要至少一张覆盖图');
    for (const c of covers) {
      if (c.width !== target.width || c.height !== target.height) {
        throw new Error('覆盖图尺寸需与目标一致');
      }
    }
    trace?.(`[cipher] 覆盖合成 layers=${covers.length} opacity=${params.opacity} fit=${params.fit}`);
    outRaster = compositeLayers(target, covers, params.opacity, params.targetLayer ?? 0);
    payload = zlibSync(asBytes(target.data), { level: 6 });
    chacha20Xor(keys.overlay, ivNonce(iv, OVERLAY_DOMAIN), payload);
    p1 = Math.round(params.opacity * 100);
    p2 = params.fit === 'cover' ? 0 : 1;
  }

  const fields: MetaFields = {
    mode: params.mode,
    pack: false,
    protection: params.protection,
    p1,
    p2,
    origWidth: target.width,
    origHeight: target.height,
  };
  return { bytes: await seal(outRaster, payload, fields, params.iterations, keys, salt, seed, iv, trace), outRaster, fields };
}

/**
 * 多图合并加密（三种保护方式均可用）。
 * 整批原图打包进加密载荷；可见图按模式取「首图打乱」或「覆盖合成」。
 * 解密端由元数据 pack 标志自动还原全部原图。
 */
export async function encryptPack(
  images: DecodedImage[],
  params: ImgVaguerParams,
  covers: Raster[] = [],
  extSeed?: Uint8Array,
  trace?: Trace,
): Promise<EncryptOutput> {
  if (!images.length) throw new Error('需要至少一张目标图');
  validateIterations(params.iterations);

  const salt = randomBytes(16);
  const seed = randomBytes(32); // none 即主密钥材料，其余为诱饵
  const iv = salt.subarray(0, IV_LEN);
  trace?.(`[key] PBKDF2-SHA256 iterations=${params.iterations} salt=${hex(salt)}`);
  const keys = await deriveKeys(params.protection, params.password, extSeed, seed, salt, params.iterations);
  trace?.(`[pack] 合并 ${images.length} 张: ${images.map((i) => i.name).join(', ')}`);

  const base = images[0].raster;
  let outRaster: Raster;
  let p1 = 0;
  let p2 = 0;
  if (params.mode === 'scramble') {
    const opts: ScrambleOptions = {
      rounds: params.rounds ?? 1,
      globalPerm: params.globalPerm ?? false,
      sbox: params.sbox ?? false,
      rowshift: params.rowshift ?? false,
    };
    trace?.(`[cipher] 可见图=首图打乱 管线 x${opts.rounds} @block${params.blockSize}`);
    outRaster = scrambleImage(base, keys, params.blockSize, params.noise, iv, opts);
    p1 = params.blockSize;
    p2 = params.noise;
  } else {
    if (!covers.length) throw new Error('需要至少一张覆盖图');
    for (const c of covers) {
      if (c.width !== base.width || c.height !== base.height) throw new Error('覆盖图尺寸需与首图一致');
    }
    trace?.(`[cipher] 可见图=覆盖合成 layers=${covers.length} opacity=${params.opacity}`);
    outRaster = compositeLayers(base, covers, params.opacity, params.targetLayer ?? 0);
    p1 = Math.round(params.opacity * 100);
    p2 = params.fit === 'cover' ? 0 : 1;
  }

  const payload = zlibSync(packImages(images), { level: 6 });
  chacha20Xor(keys.overlay, ivNonce(iv, OVERLAY_DOMAIN), payload);

  const fields: MetaFields = {
    mode: params.mode,
    pack: true,
    protection: params.protection,
    p1,
    p2,
    origWidth: base.width,
    origHeight: base.height,
  };
  return { bytes: await seal(outRaster, payload, fields, params.iterations, keys, salt, seed, iv, trace), outRaster, fields };
}

/** 轻量探测：是否含有本工具数据块及其格式版本（不泄露任何加密内容） */
export function readHeader(bytes: Uint8Array): { version: number } | null {
  const chunk = extractPngChunk(bytes, CHUNK_TYPE);
  if (!chunk || chunk.length < 1) return null;
  return { version: chunk[0] };
}

/**
 * 解密。像素从 PNG 内部无损解出，调用方无需预解码。
 * 依次尝试「密钥文件 / 口令 / 内嵌种子」三种凭据，由内部魔数判定成功者；
 * 多图合并由元数据标志自动识别，返回全部原图（不含遮盖图）。
 */
export async function decryptImage(
  bytes: Uint8Array,
  password?: string,
  keySeed?: Uint8Array,
  trace?: Trace,
): Promise<DecodedImage[]> {
  const chunk = extractPngChunk(bytes, CHUNK_TYPE);
  if (!chunk) throw new Error('未找到 ImgVaguer 数据块，非本工具生成');
  const c = parseChunk(chunk);
  if (c.version !== VERSION) throw new Error(`不支持的版本: ${c.version}`);
  validateIterations(c.iterations);
  trace?.(`[in] 数据块 v${c.version} salt=${hex(c.salt)} iterations=${c.iterations}`);

  const iv = c.salt.subarray(0, IV_LEN);
  const raster = decodePngRgba(bytes);
  trace?.(`[in] 像素无损解码 ${raster.width}x${raster.height}`);

  const labeled: { kind: string; secret: Uint8Array }[] = [];
  if (keySeed) labeled.push({ kind: 'keyfile', secret: keySeed });
  if (password) labeled.push({ kind: 'password', secret: passwordBytes(password) });
  labeled.push({ kind: 'embedded-seed', secret: c.seed });
  trace?.(`[try] 候选凭据: ${labeled.map((l) => l.kind).join(' / ')}`);

  let keys: SubKeys | null = null;
  let meta: Uint8Array | null = null;
  for (const { kind, secret } of labeled) {
    const k = await deriveSubKeys(await deriveMasterKey(secret, c.salt, c.iterations));
    const plain = new Uint8Array(c.metaCipher);
    chacha20Xor(k.meta, ivNonce(iv, META_DOMAIN), plain);
    trace?.(`[try] ${kind}: 元数据魔数${hasMetaMagic(plain) ? ' 命中' : ' 不符'}`);
    if (hasMetaMagic(plain)) { keys = k; meta = plain; break; }
  }
  if (!keys || !meta) {
    throw new Error(
      password || keySeed
        ? '口令/密钥错误或数据已损坏'
        : '该图像受口令或密钥文件保护，请提供对应凭据',
    );
  }

  const macExpect = await hmacSha256(keys.mac, concat(c.preamble, c.metaCipher, asBytes(raster.data)));
  if (!timingSafeEqual(macExpect, c.mac)) throw new Error('数据已损坏');
  trace?.('[mac] HMAC-SHA256 校验通过');

  const { fields, payload } = parseMeta(meta);
  trace?.(`[meta] 模式=${fields.mode}${fields.pack ? '+合并' : ''} p1=${fields.p1} p2=${fields.p2} 原尺寸=${fields.origWidth}x${fields.origHeight}`);

  if (fields.pack) {
    const plain = new Uint8Array(payload);
    chacha20Xor(keys.overlay, ivNonce(iv, OVERLAY_DOMAIN), plain);
    const images = unpackImages(unzlibSync(plain));
    trace?.(`[pack] 还原 ${images.length} 张`);
    return images;
  }

  if (fields.mode === 'scramble') {
    if (!BLOCK_SIZES.includes(fields.p1)) throw new Error('非法的分块尺寸');
    const restored = unscrambleImage(raster, keys, fields.p1 as BlockSize, fields.p2, iv, parseScrambleOpts(payload));
    return [{ name: '', raster: restored }];
  }

  const plain = new Uint8Array(payload);
  chacha20Xor(keys.overlay, ivNonce(iv, OVERLAY_DOMAIN), plain);
  const raw = unzlibSync(plain);
  if (raw.length !== fields.origWidth * fields.origHeight * 4) throw new Error('载荷尺寸不匹配');
  return [{
    name: '',
    raster: { width: fields.origWidth, height: fields.origHeight, data: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength) },
  }];
}

function describePipeline(noise: number, opts: ScrambleOptions): string {
  const steps = ['channel', 'xor'];
  if (opts.sbox) steps.push('sbox');
  steps.push(`noise+${noise}`);
  if (opts.rowshift) steps.push('rowshift');
  steps.push('intraPerm', 'blockPerm');
  if (opts.globalPerm) steps.push('globalPerm');
  return steps.join(' -> ');
}

function parseScrambleOpts(payload: Uint8Array): ScrambleOptions {
  if (payload.length === 0) return {};
  try {
    const j = JSON.parse(utf8Decode(payload)) as { r?: number; g?: number; s?: number; rs?: number };
    return { rounds: j.r ?? 1, globalPerm: j.g === 1, sbox: j.s === 1, rowshift: j.rs === 1 };
  } catch {
    // HMAC 已保证完整性，正常不会到此
    return {};
  }
}

function validateIterations(iterations: number): void {
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error('非法的迭代次数');
  }
}
