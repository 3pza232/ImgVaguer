import { chacha20Block, chacha20Stream, chacha20StreamAt, chacha20Xor } from '@/core/chacha';
import { buildHeader, HEADER_LEN, HMAC_LEN, parseHeader } from '@/core/header';
import { deriveSubKeys, type SubKeys } from '@/core/kdf';
import { generateKeyFile, parseKeyFile, randomKeySeed } from '@/core/keyfile';
import { composite, compositeLayers } from '@/core/overlay';
import { encodePng, extractPngChunk } from '@/core/png';
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
        const enc = scrambleImage(src, k, b, amp);
        expect(hex(new Uint8Array(enc.data.buffer))).not.toBe(hex(new Uint8Array(src.data.buffer)));
        const dec = unscrambleImage(enc, k, b, amp);
        expect(dec.data).toEqual(src.data);
      });
    }
  }

  it('全叠加算法：多轮+S盒+行列移位+全局置换往返逐位一致', async () => {
    const k = await testKeys();
    const src = randomRaster(70, 50);
    const opts = { rounds: 3, sbox: true, rowshift: true, globalPerm: true };
    const enc = scrambleImage(src, k, 16, 24, opts);
    expect(enc.data).not.toEqual(src.data);
    const dec = unscrambleImage(enc, k, 16, 24, opts);
    expect(dec.data).toEqual(src.data);
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
    const bytes = encodePng(r, { type: 'ivGr', data: payload });
    const got = extractPngChunk(bytes, 'ivGr');
    expect(got).not.toBeNull();
    expect(hex(got!)).toBe(hex(payload));
    expect(extractPngChunk(bytes, 'abcd')).toBeNull();
  });
});

describe('header', () => {
  it('build/parse 往返', () => {
    const f = {
      mode: 'overlay' as const,
      protection: 'keyfile' as const,
      iterations: 123456,
      p1: 95,
      p2: 1,
      salt: randomBytes(16),
      seed: randomBytes(32),
      origWidth: 640,
      origHeight: 480,
      payloadLen: 999,
    };
    const parsed = parseHeader(buildHeader(f));
    expect(parsed).toEqual(f);
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

  it('scramble 无保护：加密/解密逐位还原', async () => {
    const src = randomRaster(64, 48);
    const params: ScrambleParams = { ...base, mode: 'scramble', protection: 'none', password: '', blockSize: 16, noise: 24 };
    const out = await encryptImage(src, params);
    const header = readHeader(out.bytes);
    expect(header?.mode).toBe('scramble');
    expect(header?.protection).toBe('none');
    const dec = await decryptImage(out.bytes, out.outRaster);
    expect(dec.data).toEqual(src.data);
  });

  it('scramble 口令：正确口令还原，错误口令拒绝', async () => {
    const src = randomRaster(64, 64);
    const params: ScrambleParams = { ...base, mode: 'scramble', protection: 'password', password: 's3cret', blockSize: 8, noise: 8 };
    const out = await encryptImage(src, params);
    const dec = await decryptImage(out.bytes, out.outRaster, 's3cret');
    expect(dec.data).toEqual(src.data);
    await expect(decryptImage(out.bytes, out.outRaster, 'wrong')).rejects.toThrow('口令/密钥错误或数据已损坏');
  });

  it('scramble 密钥文件：凭种子还原，缺种子/错种子拒绝', async () => {
    const src = randomRaster(64, 64);
    const seed = randomKeySeed();
    const params: ScrambleParams = { ...base, mode: 'scramble', protection: 'keyfile', password: '', blockSize: 16, noise: 16 };
    const out = await encryptImage(src, params, [], seed);
    expect(readHeader(out.bytes)?.protection).toBe('keyfile');
    const dec = await decryptImage(out.bytes, out.outRaster, undefined, seed);
    expect(dec.data).toEqual(src.data);
    await expect(decryptImage(out.bytes, out.outRaster)).rejects.toThrow('密钥文件');
    await expect(decryptImage(out.bytes, out.outRaster, undefined, randomKeySeed())).rejects.toThrow();
  });

  it('scramble 专业参数经头部自动往返', async () => {
    const src = randomRaster(64, 48);
    const params: ScrambleParams = {
      ...base, mode: 'scramble', protection: 'password', password: 'pro',
      blockSize: 16, noise: 24, rounds: 2, globalPerm: true, sbox: true, rowshift: true,
    };
    const out = await encryptImage(src, params);
    expect(readHeader(out.bytes)?.payloadLen).toBeGreaterThan(0);
    const dec = await decryptImage(out.bytes, out.outRaster, 'pro');
    expect(dec.data).toEqual(src.data);
  });

  it('overlay 口令：原图从加密载荷逐位还原', async () => {
    const target = randomRaster(48, 48);
    const cover = opaqueRaster(48, 48);
    const params: OverlayParams = { ...base, mode: 'overlay', protection: 'password', password: 'pw', opacity: 1, fit: 'cover' };
    const out = await encryptImage(target, params, [cover]);
    expect(out.outRaster.data).toEqual(cover.data); // 视觉上完全被覆盖
    const dec = await decryptImage(out.bytes, null, 'pw');
    expect(dec.data).toEqual(target.data);
    await expect(decryptImage(out.bytes, null, 'nope')).rejects.toThrow();
  });

  it('overlay 多层：目标层在顶层时输出含真图，载荷仍还原原图', async () => {
    const target = opaqueRaster(32, 32);
    const c1 = opaqueRaster(32, 32);
    const params: OverlayParams = { ...base, mode: 'overlay', protection: 'none', password: '', opacity: 1, fit: 'cover', targetLayer: 1 };
    const out = await encryptImage(target, params, [c1]);
    expect(out.outRaster.data).toEqual(target.data); // 真图在最上层可见
    const dec = await decryptImage(out.bytes, null);
    expect(dec.data).toEqual(target.data);
  });

  it('篡改检测：改动数据块任意字节即拒绝', async () => {
    const src = randomRaster(32, 32);
    const params: ScrambleParams = { ...base, mode: 'scramble', protection: 'none', password: '', blockSize: 16, noise: 0 };
    const out = await encryptImage(src, params);
    const chunk = extractPngChunk(out.bytes, 'ivGr')!;
    // 找到 chunk 数据在文件中的位置并翻转 HMAC 末字节
    const idx = out.bytes.findIndex((_, i) =>
      i + 3 < out.bytes.length &&
      out.bytes[i] === chunk[0] && out.bytes[i + 1] === chunk[1] &&
      out.bytes[i + 2] === chunk[2] && out.bytes[i + 3] === chunk[3],
    );
    expect(idx).toBeGreaterThan(0);
    out.bytes[idx + HEADER_LEN + HMAC_LEN - 1] ^= 0xff;
    await expect(decryptImage(out.bytes, out.outRaster)).rejects.toThrow();
  });
});
