import { chacha20Block, chacha20Stream, chacha20StreamAt, chacha20Xor, IV_LEN } from '@/core/chacha';
import {
  buildChunk,
  buildMeta,
  buildPreamble,
  CHUNK_TYPE,
  hasMetaMagic,
  HMAC_LEN,
  parseChunk,
  parseMeta,
  VERSION,
  type MetaFields,
} from '@/core/header';
import { deriveSubKeys, type SubKeys } from '@/core/kdf';
import { generateKeyFile, parseKeyFile, randomKeySeed } from '@/core/keyfile';
import { composite, compositeLayers } from '@/core/overlay';
import { decodePngRgba, encodePng, extractPngChunk } from '@/core/png';
import { scrambleImage, unscrambleImage, type BlockSize } from '@/core/scramble';
import type { OverlayParams, Raster, ScrambleParams } from '@/core/types';
import { decryptImage, encryptImage, readHeader } from '@/services/engine';
import { describe, expect, it } from 'vitest';

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function randomIv(): Uint8Array {
  return randomBytes(IV_LEN);
}

function randomRaster(w: number, h: number): Raster {
  const data = new Uint8ClampedArray(w * h * 4);
  crypto.getRandomValues(data);
  return { width: w, height: h, data };
}

function opaqueRaster(w: number, h: number): Raster {
  const r = randomRaster(w, h);
  for (let i = 3; i < r.data.length; i += 4) r.data[i] = 255;
  return r;
}

let keys: SubKeys;
async function testKeys(): Promise<SubKeys> {
  keys ??= await deriveSubKeys(randomBytes(32));
  return keys;
}

describe('chacha20', () => {
  it('RFC 8439 测试向量', () => {
    const key = new Uint8Array(32).map((_, i) => i);
    const nonce = new Uint8Array([0, 0, 0, 9, 0, 0, 0, 0x4a, 0, 0, 0, 0]);
    const out = chacha20Block(key, 1, nonce);
    expect(hex(out.subarray(0, 16))).toBe('10f1e7e4d13b5915500fdd1fa32071c4');
  });

  it('异或对称', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const data = randomBytes(1000);
    const copy = new Uint8Array(data);
    chacha20Xor(key, nonce, data);
    expect(hex(data)).not.toBe(hex(copy));
    chacha20Xor(key, nonce, data);
    expect(hex(data)).toBe(hex(copy));
  });

  it('streamAt 与 stream 切片一致（非对齐偏移）', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const full = chacha20Stream(key, nonce, 1000);
    const part = chacha20StreamAt(key, nonce, 130, 500);
    expect(hex(part)).toBe(hex(full.subarray(130, 630)));
  });
});

describe('scramble', () => {
  const sizes: BlockSize[] = [8, 16, 32];
  const amps = [0, 16, 64];

  for (const b of sizes) {
    for (const amp of amps) {
      it(`往返逐位一致 block=${b} noise=${amp}（含非整除边缘）`, async () => {
        const k = await testKeys();
        const src = randomRaster(70, 50);
        const iv = randomIv();
        const enc = scrambleImage(src, k, b, amp, iv);
        expect(hex(new Uint8Array(enc.data.buffer))).not.toBe(hex(new Uint8Array(src.data.buffer)));
        const dec = unscrambleImage(enc, k, b, amp, iv);
        expect(dec.data).toEqual(src.data);
      });
    }
  }

  it('全叠加算法：多轮+S盒+行列移位+全局置换往返逐位一致', async () => {
    const k = await testKeys();
    const src = randomRaster(70, 50);
    const opts = { rounds: 3, sbox: true, rowshift: true, globalPerm: true };
    const iv = randomIv();
    const enc = scrambleImage(src, k, 16, 24, iv, opts);
    expect(enc.data).not.toEqual(src.data);
    const dec = unscrambleImage(enc, k, 16, 24, iv, opts);
    expect(dec.data).toEqual(src.data);
  });

  it('同一密钥 + 不同 IV 产出不同密文（无密钥流复用）', async () => {
    const k = await testKeys();
    const src = randomRaster(64, 64);
    const a = scrambleImage(src, k, 16, 16, randomIv());
    const b = scrambleImage(src, k, 16, 16, randomIv());
    expect(a.data).not.toEqual(b.data);
  });

  it('IV 错误无法还原', async () => {
    const k = await testKeys();
    const src = randomRaster(48, 48);
    const enc = scrambleImage(src, k, 16, 16, randomIv());
    const dec = unscrambleImage(enc, k, 16, 16, randomIv());
    expect(dec.data).not.toEqual(src.data);
  });
});

describe('overlay composite', () => {
  it('不透明度 1 且覆盖图不透明时输出等于覆盖图', () => {
    const target = randomRaster(32, 32);
    const cover = opaqueRaster(32, 32);
    const out = composite(target, cover, 1);
    expect(out.data).toEqual(cover.data);
  });

  it('多层叠图：目标在最底层时被顶层覆盖图完全遮盖', () => {
    const target = randomRaster(24, 24);
    const c1 = opaqueRaster(24, 24);
    const c2 = opaqueRaster(24, 24);
    const out = compositeLayers(target, [c1, c2], 1, 0);
    expect(out.data).toEqual(c2.data);
  });

  it('多层叠图：目标在最上层时保持可见', () => {
    const target = opaqueRaster(24, 24);
    const c1 = opaqueRaster(24, 24);
    const out = compositeLayers(target, [c1], 1, 1);
    expect(out.data).toEqual(target.data);
  });
});

describe('png chunk', () => {
  it('encode/extract 往返', () => {
    const r = randomRaster(17, 9);
    const payload = randomBytes(123);
    const bytes = encodePng(r, { type: CHUNK_TYPE, data: payload });
    const got = extractPngChunk(bytes, CHUNK_TYPE);
    expect(got).not.toBeNull();
    expect(hex(got!)).toBe(hex(payload));
    expect(extractPngChunk(bytes, 'abcd')).toBeNull();
  });

  it('decode：像素逐位无损还原', () => {
    const r = randomRaster(19, 7); // 含随机 alpha
    const back = decodePngRgba(encodePng(r));
    expect(back.width).toBe(r.width);
    expect(back.height).toBe(r.height);
    expect(back.data).toEqual(r.data);
  });

  it('decode：拒绝非 RGBA 或非 PNG 输入', () => {
    expect(() => decodePngRgba(randomBytes(32))).toThrow();
  });
});

describe('header', () => {
  it('chunk：前导与密文往返', () => {
    const salt = randomBytes(16);
    const seed = randomBytes(32);
    const metaCipher = randomBytes(64);
    const mac = randomBytes(HMAC_LEN);
    const chunk = buildChunk(buildPreamble(VERSION, salt, 123456, seed), metaCipher, mac);
    const p = parseChunk(chunk);
    expect(p.version).toBe(VERSION);
    expect(p.salt).toEqual(salt);
    expect(p.seed).toEqual(seed);
    expect(p.iterations).toBe(123456);
    expect(hex(p.metaCipher)).toBe(hex(metaCipher));
    expect(hex(p.mac)).toBe(hex(mac));
  });

  it('meta：字段与载荷往返', () => {
    const fields: MetaFields = {
      mode: 'overlay',
      protection: 'keyfile',
      p1: 95,
      p2: 1,
      origWidth: 640,
      origHeight: 480,
    };
    const payload = new TextEncoder().encode('{"r":2}');
    const buf = buildMeta(fields, payload);
    expect(hasMetaMagic(buf)).toBe(true);
    const parsed = parseMeta(buf);
    expect(parsed.fields).toEqual(fields);
    expect(hex(parsed.payload)).toBe(hex(payload));
  });

  it('meta：乱码不通过内部魔数校验', () => {
    expect(hasMetaMagic(randomBytes(64))).toBe(false);
  });
});

describe('keyfile', () => {
  it('生成/解析往返', () => {
    const seed = randomKeySeed();
    const text = generateKeyFile(seed);
    expect(text.startsWith('IMGVAGUER-KEY v1')).toBe(true);
    expect(parseKeyFile(text)).toEqual(seed);
  });

  it('非法文件拒绝', () => {
    expect(() => parseKeyFile('hello\nAAAA')).toThrow();
    expect(() => parseKeyFile('IMGVAGUER-KEY v1\n!!!')).toThrow();
    expect(() => parseKeyFile('IMGVAGUER-KEY v1\nQUJD')).toThrow('密钥长度非法');
  });
});

describe('engine', () => {
  const base = { iterations: 1000 };

  it('scramble 无保护：加密/解密逐位还原（像素经无损解码）', async () => {
    const src = randomRaster(64, 48);
    const params: ScrambleParams = { ...base, mode: 'scramble', protection: 'none', password: '', blockSize: 16, noise: 24 };
    const out = await encryptImage(src, params);
    expect(readHeader(out.bytes)?.version).toBe(VERSION);
    const dec = await decryptImage(out.bytes);
    expect(dec.data).toEqual(src.data);
  });

  it('去指纹：数据块不含品牌标识与明文参数', async () => {
    const src = randomRaster(48, 48);
    const params: ScrambleParams = {
      ...base, mode: 'scramble', protection: 'password', password: 'pw',
      blockSize: 32, noise: 40, rounds: 3, globalPerm: true, sbox: true, rowshift: true,
    };
    const out = await encryptImage(src, params);
    const chunk = extractPngChunk(out.bytes, CHUNK_TYPE)!;
    const text = new TextDecoder().decode(chunk);
    expect(text).not.toContain('IVGR');
    expect(text).not.toContain('ImgVaguer');
    expect(text).not.toContain('IVGMETA3');
  });

  it('scramble 口令：正确口令还原，错误口令拒绝', async () => {
    const src = randomRaster(64, 64);
    const params: ScrambleParams = { ...base, mode: 'scramble', protection: 'password', password: 's3cret', blockSize: 8, noise: 8 };
    const out = await encryptImage(src, params);
    const dec = await decryptImage(out.bytes, 's3cret');
    expect(dec.data).toEqual(src.data);
    await expect(decryptImage(out.bytes, 'wrong')).rejects.toThrow('口令/密钥错误或数据已损坏');
  });

  it('scramble 密钥文件：凭种子还原，缺种子/错种子拒绝', async () => {
    const src = randomRaster(64, 64);
    const seed = randomKeySeed();
    const params: ScrambleParams = { ...base, mode: 'scramble', protection: 'keyfile', password: '', blockSize: 16, noise: 16 };
    const out = await encryptImage(src, params, [], seed);
    expect(readHeader(out.bytes)?.version).toBe(VERSION);
    const dec = await decryptImage(out.bytes, undefined, seed);
    expect(dec.data).toEqual(src.data);
    await expect(decryptImage(out.bytes)).rejects.toThrow('密钥文件');
    await expect(decryptImage(out.bytes, undefined, randomKeySeed())).rejects.toThrow();
  });

  it('密钥文件：逐图 IV 生效，同种子两次加密不共享密钥流', async () => {
    const src = randomRaster(48, 48);
    const seed = randomKeySeed();
    const params: ScrambleParams = { ...base, mode: 'scramble', protection: 'keyfile', password: '', blockSize: 16, noise: 16 };
    const a = await encryptImage(src, params, [], seed);
    const b = await encryptImage(src, params, [], seed);
    expect(a.outRaster.data).not.toEqual(b.outRaster.data);
    expect((await decryptImage(a.bytes, undefined, seed)).data).toEqual(src.data);
    expect((await decryptImage(b.bytes, undefined, seed)).data).toEqual(src.data);
  });

  it('scramble 专业参数经头部自动往返', async () => {
    const src = randomRaster(64, 48);
    const params: ScrambleParams = {
      ...base, mode: 'scramble', protection: 'password', password: 'pro',
      blockSize: 16, noise: 24, rounds: 2, globalPerm: true, sbox: true, rowshift: true,
    };
    const out = await encryptImage(src, params);
    const dec = await decryptImage(out.bytes, 'pro');
    expect(dec.data).toEqual(src.data);
  });

  it('overlay 口令：原图从加密载荷逐位还原', async () => {
    const target = randomRaster(48, 48);
    const cover = opaqueRaster(48, 48);
    const params: OverlayParams = { ...base, mode: 'overlay', protection: 'password', password: 'pw', opacity: 1, fit: 'cover' };
    const out = await encryptImage(target, params, [cover]);
    expect(out.outRaster.data).toEqual(cover.data); // 视觉上完全被覆盖
    const dec = await decryptImage(out.bytes, 'pw');
    expect(dec.data).toEqual(target.data);
    await expect(decryptImage(out.bytes, 'nope')).rejects.toThrow();
  });

  it('overlay 多层：目标层在顶层时输出含真图，载荷仍还原原图', async () => {
    const target = opaqueRaster(32, 32);
    const c1 = opaqueRaster(32, 32);
    const params: OverlayParams = { ...base, mode: 'overlay', protection: 'none', password: '', opacity: 1, fit: 'cover', targetLayer: 1 };
    const out = await encryptImage(target, params, [c1]);
    expect(out.outRaster.data).toEqual(target.data); // 真图在最上层可见
    const dec = await decryptImage(out.bytes);
    expect(dec.data).toEqual(target.data);
  });

  it('像素无损解码：原样重编码后仍可逐位还原', async () => {
    const src = randomRaster(40, 24); // 含随机 alpha，验证解码不经过 canvas
    const params: ScrambleParams = { ...base, mode: 'scramble', protection: 'password', password: 'pw', blockSize: 8, noise: 12 };
    const out = await encryptImage(src, params);
    const reencoded = encodePng(out.outRaster, { type: CHUNK_TYPE, data: extractPngChunk(out.bytes, CHUNK_TYPE)! });
    const dec = await decryptImage(reencoded, 'pw');
    expect(dec.data).toEqual(src.data);
  });

  it('密文认证：像素被改动即拒绝', async () => {
    const src = randomRaster(32, 32);
    const params: ScrambleParams = { ...base, mode: 'scramble', protection: 'password', password: 'pw', blockSize: 16, noise: 0 };
    const out = await encryptImage(src, params);
    const tampered: Raster = { ...out.outRaster, data: out.outRaster.data.slice() };
    tampered.data[0] ^= 0xff;
    const reencoded = encodePng(tampered, { type: CHUNK_TYPE, data: extractPngChunk(out.bytes, CHUNK_TYPE)! });
    await expect(decryptImage(reencoded, 'pw')).rejects.toThrow('数据已损坏');
  });

  it('篡改检测：改动 MAC 任意字节即拒绝', async () => {
    const src = randomRaster(32, 32);
    const params: ScrambleParams = { ...base, mode: 'scramble', protection: 'password', password: 'pw', blockSize: 16, noise: 0 };
    const out = await encryptImage(src, params);
    const chunk = extractPngChunk(out.bytes, CHUNK_TYPE)!;
    chunk[chunk.length - 1] ^= 0xff; // 翻转 chunk 内 MAC 末字节
    await expect(decryptImage(out.bytes, 'pw')).rejects.toThrow('数据已损坏');
  });
});
