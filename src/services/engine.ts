/**
 * 编排层：密钥调度 + 模式分发 + 头部/HMAC 封装。
 * DOM 无关，encrypt/decrypt 均可在 worker 或测试中运行。
 *
 * 保护方式：
 *  - none     随机种子内嵌头部，持图即可还原
 *  - password PBKDF2(口令, salt) 派生主密钥
 *  - keyfile  外部 32B 密钥文件即主密钥，头部不内嵌任何密钥材料
 */
import { chacha20Xor } from '@/core/chacha';
import { buildHeader, CHUNK_TYPE, HEADER_LEN, HMAC_LEN, parseHeader, type HeaderFields } from '@/core/header';
import { deriveMasterKey, deriveSubKeys, hmacSha256, timingSafeEqual } from '@/core/kdf';
import { compositeLayers } from '@/core/overlay';
import { encodePng, extractPngChunk } from '@/core/png';
import { scrambleImage, unscrambleImage, type BlockSize, type ScrambleOptions } from '@/core/scramble';
import type { ImgVaguerParams, Raster } from '@/core/types';
import { unzlibSync, zlibSync } from 'fflate';

const ZERO_NONCE = new Uint8Array(12);
const BLOCK_SIZES: readonly number[] = [8, 16, 32];

export interface EncryptOutput {
  bytes: Uint8Array;
  outRaster: Raster;
  fields: HeaderFields;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * @param covers  覆盖图层（已缩放至目标尺寸），按叠放顺序排列
 * @param extSeed keyfile 模式下由调用方生成的 32B 密钥种子
 */
export async function encryptImage(
  target: Raster,
  params: ImgVaguerParams,
  covers: Raster[] = [],
  extSeed?: Uint8Array,
): Promise<EncryptOutput> {
  const protection = params.protection;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  let seedField = new Uint8Array(32);
  let master: Uint8Array;

  if (protection === 'password') {
    master = await deriveMasterKey(params.password, salt, params.iterations);
  } else if (protection === 'keyfile') {
    if (!extSeed || extSeed.length !== 32) throw new Error('缺少密钥种子');
    master = extSeed;
  } else {
    seedField = crypto.getRandomValues(new Uint8Array(32));
    master = seedField;
  }
  const keys = await deriveSubKeys(master);

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
    outRaster = scrambleImage(target, keys, params.blockSize, params.noise, opts);
    // 非默认参数以 JSON 存入受 HMAC 保护的 payload 区，解密端自动读取
    if (opts.rounds! > 1 || opts.globalPerm || opts.sbox || opts.rowshift) {
      payload = new TextEncoder().encode(JSON.stringify({
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
    outRaster = compositeLayers(target, covers, params.opacity, params.targetLayer ?? 0);
    const raw = new Uint8Array(target.data.buffer, target.data.byteOffset, target.data.byteLength);
    payload = zlibSync(raw, { level: 6 });
    chacha20Xor(keys.overlay, ZERO_NONCE, payload);
    p1 = Math.round(params.opacity * 100);
    p2 = params.fit === 'cover' ? 0 : 1;
  }

  const fields: HeaderFields = {
    mode: params.mode,
    protection,
    iterations: params.iterations,
    p1,
    p2,
    salt,
    seed: seedField,
    origWidth: target.width,
    origHeight: target.height,
    payloadLen: payload.length,
  };
  const head = buildHeader(fields);
  const mac = await hmacSha256(keys.mac, concat(head, payload));
  const bytes = encodePng(outRaster, { type: CHUNK_TYPE, data: concat(head, mac, payload) });
  return { bytes, outRaster, fields };
}

/** 仅读取头部，用于探测图像是否由本工具生成 */
export function readHeader(bytes: Uint8Array): HeaderFields | null {
  const chunk = extractPngChunk(bytes, CHUNK_TYPE);
  return chunk ? parseHeader(chunk) : null;
}

/**
 * 解密。scramble 模式需传入从 PNG 解码出的像素 raster；
 * overlay 模式像素无关，传 null 即可。
 * keyfile 保护的图像必须提供 keySeed。
 */
export async function decryptImage(
  bytes: Uint8Array,
  raster: Raster | null,
  password?: string,
  keySeed?: Uint8Array,
): Promise<Raster> {
  const chunk = extractPngChunk(bytes, CHUNK_TYPE);
  if (!chunk) throw new Error('未找到 ImgVaguer 数据块，非本工具生成');
  const f = parseHeader(chunk);
  if (chunk.length < HEADER_LEN + HMAC_LEN + f.payloadLen) throw new Error('数据块被截断');

  const macGiven = chunk.subarray(HEADER_LEN, HEADER_LEN + HMAC_LEN);
  const payload = chunk.subarray(HEADER_LEN + HMAC_LEN, HEADER_LEN + HMAC_LEN + f.payloadLen);

  let master: Uint8Array;
  if (f.protection === 'password') {
    master = await deriveMasterKey(password ?? '', f.salt, f.iterations);
  } else if (f.protection === 'keyfile') {
    if (!keySeed) throw new Error('该图像受密钥文件保护，请先载入 .ivkey 密钥文件');
    master = keySeed;
  } else {
    master = f.seed;
  }
  const keys = await deriveSubKeys(master);

  const macExpect = await hmacSha256(keys.mac, concat(chunk.subarray(0, HEADER_LEN), payload));
  if (!timingSafeEqual(macExpect, macGiven)) {
    throw new Error(f.protection === 'none' ? '数据已损坏' : '口令/密钥错误或数据已损坏');
  }

  if (f.mode === 'scramble') {
    if (!raster) throw new Error('缺少图像像素数据');
    if (!BLOCK_SIZES.includes(f.p1)) throw new Error('非法的分块尺寸');
    let opts: ScrambleOptions = {};
    if (f.payloadLen > 0) {
      try {
        const j = JSON.parse(new TextDecoder().decode(payload)) as { r?: number; g?: number; s?: number; rs?: number };
        opts = { rounds: j.r ?? 1, globalPerm: j.g === 1, sbox: j.s === 1, rowshift: j.rs === 1 };
      } catch {
        // 参数块损坏时按默认参数处理（HMAC 已保证完整性，正常不会到此）
      }
    }
    return unscrambleImage(raster, keys, f.p1 as BlockSize, f.p2, opts);
  }

  const plain = new Uint8Array(payload);
  chacha20Xor(keys.overlay, ZERO_NONCE, plain);
  const raw = unzlibSync(plain);
  if (raw.length !== f.origWidth * f.origHeight * 4) throw new Error('载荷尺寸不匹配');
  return {
    width: f.origWidth,
    height: f.origHeight,
    data: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength),
  };
}
