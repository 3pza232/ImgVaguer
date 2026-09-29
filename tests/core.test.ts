import { ChaCha20, IV_LEN, ivNonce } from '@/core/chacha';
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
  type PayloadKind,
} from '@/core/header';
import { deriveMasterKey, deriveSubKeys, hkdfSha256, type SubKeys } from '@/core/kdf';
import { generateKeyFile, KEY_MAGIC, parseKeyFile, randomKeySeed } from '@/core/keyfile';
import { compositeLayers } from '@/core/overlay';
import { composeSlices, formatBytes, formatMs, itemStat, shares, statRows, summarize } from '@/core/stats';
import {
  decodePngRgba,
  encodePng,
  extractPngChunk,
  filterScanlines,
  isOpaque,
  LEVEL_RAW,
  unfilterScanlines,
} from '@/core/png';
import { scrambleImage, unscrambleImage, type BlockSize } from '@/core/scramble';
import type { HybridParams, OverlayParams, Raster, ScrambleParams } from '@/core/types';
import {
  decryptImage,
  encryptImage,
  encryptPack,
  readHeader,
  type DecodedImage,
  type EncryptInput,
} from '@/services/engine';
import { describe, expect, it } from 'vitest';

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) b.set(crypto.getRandomValues(new Uint8Array(Math.min(65536, n - o))), o);
  return b;
}

function randomIv(): Uint8Array {
  return randomBytes(IV_LEN);
}

function randomRaster(w: number, h: number): Raster {
  return { width: w, height: h, data: new Uint8ClampedArray(randomBytes(w * h * 4)) };
}

function opaqueRaster(w: number, h: number): Raster {
  const r = randomRaster(w, h);
  for (let i = 3; i < r.data.length; i += 4) r.data[i] = 255;
  return r;
}

/** 平滑图像：用于验证滤波、压缩与体积收益（随机图像不可压缩，无法体现差异） */
function smoothRaster(w: number, h: number): Raster {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = (x * 255) / w;
      data[o + 1] = (y * 255) / h;
      data[o + 2] = ((x + y) * 255) / (w + h);
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
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
    const out = new Uint8Array(64);
    new ChaCha20(key, nonce).streamInto(out, 64, 64); // counter = 1
    expect(hex(out.subarray(0, 16))).toBe('10f1e7e4d13b5915500fdd1fa32071c4');
  });

  it('异或对称', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const data = randomBytes(1000);
    const copy = new Uint8Array(data);
    new ChaCha20(key, nonce).xor(data);
    expect(hex(data)).not.toBe(hex(copy));
    new ChaCha20(key, nonce).xor(data);
    expect(hex(data)).toBe(hex(copy));
  });

  it('分块取流与整段取流一致（非对齐偏移）', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const full = new Uint8Array(1000);
    new ChaCha20(key, nonce).streamInto(full, 0, 1000);
    const part = new Uint8Array(500);
    new ChaCha20(key, nonce).streamInto(part, 130, 500);
    expect(hex(part)).toBe(hex(full.subarray(130, 630)));
  });

  it('below 恒落在 [0, n) 且覆盖全部取值', () => {
    const rng = new ChaCha20(randomBytes(32), randomBytes(12));
    const seen = new Set<number>();
    for (let i = 0; i < 4000; i++) {
      const v = rng.below(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      seen.add(v);
    }
    expect(seen.size).toBe(7);
  });

  it('域分离：同 IV 不同域不共享密钥流', () => {
    const key = randomBytes(32);
    const iv = randomIv();
    const a = new Uint8Array(64);
    const b = new Uint8Array(64);
    new ChaCha20(key, ivNonce(iv, 1)).streamInto(a, 0, 64);
    new ChaCha20(key, ivNonce(iv, 2)).streamInto(b, 0, 64);
    expect(hex(a)).not.toBe(hex(b));
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
        expect(unscrambleImage(enc, k, b, amp, iv).data).toEqual(src.data);
      });
    }
  }

  it('全局置换（两级分块）：跨越块边界与余量的尺寸均往返逐位一致', async () => {
    const k = await testKeys();
    for (const [w, h] of [[70, 50], [64, 64], [100, 100], [4097, 2]] as const) {
      const src = randomRaster(w, h);
      const iv = randomIv();
      const enc = scrambleImage(src, k, 16, 16, iv, { globalPerm: true });
      expect(enc.data).not.toEqual(src.data);
      expect(unscrambleImage(enc, k, 16, 16, iv, { globalPerm: true }).data).toEqual(src.data);
    }
  });

  it('历史整表置换（permVersion 1）仍可还原', async () => {
    const k = await testKeys();
    const src = randomRaster(50, 40);
    const iv = randomIv();
    const opts = { globalPerm: true, permVersion: 1 as const };
    expect(unscrambleImage(scrambleImage(src, k, 16, 16, iv, opts), k, 16, 16, iv, opts).data).toEqual(src.data);
  });

  it('全叠加算法：多轮+S盒+行列移位+全局置换往返逐位一致', async () => {
    const k = await testKeys();
    const src = randomRaster(70, 50);
    const opts = { rounds: 3, sbox: true, rowshift: true, globalPerm: true };
    const iv = randomIv();
    const enc = scrambleImage(src, k, 16, 24, iv, opts);
    expect(enc.data).not.toEqual(src.data);
    expect(unscrambleImage(enc, k, 16, 24, iv, opts).data).toEqual(src.data);
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
    expect(unscrambleImage(enc, k, 16, 16, randomIv()).data).not.toEqual(src.data);
  });

  it('不修改输入位图', async () => {
    const k = await testKeys();
    const src = randomRaster(32, 32);
    const before = src.data.slice();
    scrambleImage(src, k, 16, 16, randomIv(), { globalPerm: true });
    expect(src.data).toEqual(before);
  });
});

describe('overlay composite', () => {
  it('不透明度 1 且覆盖图不透明时输出等于覆盖图', () => {
    const target = randomRaster(32, 32);
    const cover = opaqueRaster(32, 32);
    expect(compositeLayers(target, [cover], 1, 0).data).toEqual(cover.data);
  });

  it('多层叠图：目标在最底层时被顶层覆盖图完全遮盖', () => {
    const target = randomRaster(24, 24);
    const c1 = opaqueRaster(24, 24);
    const c2 = opaqueRaster(24, 24);
    expect(compositeLayers(target, [c1, c2], 1, 0).data).toEqual(c2.data);
  });

  it('层序：数组末位是顶层（图层条 L1 显示为末位）', () => {
    const target = randomRaster(24, 24);
    const bottom = opaqueRaster(24, 24);
    const top = opaqueRaster(24, 24);
    // 不透明度 1 时，结果就是最上面那一层：末位那个
    expect(compositeLayers(target, [bottom, top], 1, 0).data).toEqual(top.data);
    expect(compositeLayers(target, [top, bottom], 1, 0).data).toEqual(bottom.data);
  });

  it('多层叠图：目标在最上层时保持可见', () => {
    const target = opaqueRaster(24, 24);
    const c1 = opaqueRaster(24, 24);
    expect(compositeLayers(target, [c1], 1, 1).data).toEqual(target.data);
  });
});

describe('png', () => {
  it('encode/extract 往返', () => {
    const r = randomRaster(17, 9);
    const payload = randomBytes(123);
    const bytes = encodePng(r, { extra: { type: CHUNK_TYPE, data: payload } });
    const got = extractPngChunk(bytes, CHUNK_TYPE);
    expect(got).not.toBeNull();
    expect(hex(got!)).toBe(hex(payload));
    expect(extractPngChunk(bytes, 'abcd')).toBeNull();
  });

  it('decode：RGBA 像素逐位无损还原', () => {
    const r = randomRaster(19, 7);
    const back = decodePngRgba(encodePng(r));
    expect(back.width).toBe(r.width);
    expect(back.height).toBe(r.height);
    expect(back.data).toEqual(r.data);
  });

  it('decode：全不透明图像按 RGB 编码并补回 alpha=255', () => {
    const r = opaqueRaster(23, 11);
    const bytes = encodePng(r);
    expect(extractPngChunk(bytes, 'IHDR')![9]).toBe(2); // color type 2 = RGB
    expect(decodePngRgba(bytes).data).toEqual(r.data);
  });

  it('扫描线编解码往返（含非透明 / 全不透明两种通道数）', () => {
    const rgba = randomRaster(31, 13);
    expect(unfilterScanlines(filterScanlines(rgba), 31, 13).data).toEqual(rgba.data);
    const rgb = opaqueRaster(31, 13);
    expect(unfilterScanlines(filterScanlines(rgb, 255), 31, 13).data).toEqual(rgb.data);
  });

  it('扫描线长度与尺寸不符即拒绝', () => {
    expect(() => unfilterScanlines(new Uint8Array(10), 4, 4)).toThrow('扫描线长度');
  });

  it('自适应滤波显著提升可压缩性（防止退化为不滤波）', () => {
    const r = smoothRaster(96, 96);
    const stored = encodePng(r, { level: LEVEL_RAW }).length;
    expect(encodePng(r).length).toBeLessThan(stored * 0.2);
  });

  it('RGB 编码省去 alpha 通道', () => {
    const r = opaqueRaster(64, 64);
    expect(extractPngChunk(encodePng(r), 'IHDR')![9]).toBe(2);
    expect(encodePng(r).length).toBeLessThan(64 * 64 * 4);
  });

  it('isOpaque 判定', () => {
    expect(isOpaque(opaqueRaster(8, 8))).toBe(true);
    expect(isOpaque(randomRaster(8, 8))).toBe(false);
  });

  it('decode：拒绝非 PNG 输入', () => {
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

  it('meta：字段与载荷往返（含全部标志位）', () => {
    for (const mode of ['scramble', 'overlay'] as const) {
      for (const pack of [false, true]) {
        for (const payloadKind of ['mode', 'file'] as PayloadKind[]) {
          for (const pixelCipher of [false, true]) {
            const fields: MetaFields = {
              mode, pack, protection: 'keyfile', payloadKind, pixelCipher,
              p1: 95, p2: 1, origWidth: 640, origHeight: 480,
            };
            const payload = new TextEncoder().encode('{"r":2}');
            const buf = buildMeta(fields, payload);
            expect(hasMetaMagic(buf)).toBe(true);
            const parsed = parseMeta(buf);
            expect(parsed.fields).toEqual(fields);
            expect(hex(parsed.payload)).toBe(hex(payload));
          }
        }
      }
    }
  });

  it('meta：乱码不通过内部魔数校验', () => {
    expect(hasMetaMagic(randomBytes(64))).toBe(false);
  });
});

describe('kdf', () => {
  it('HKDF 确定性且随 salt / info 隔离', async () => {
    const ikm = randomBytes(32);
    const salt = randomBytes(16);
    const a = await hkdfSha256(ikm, salt, 'info-a');
    expect(hex(await hkdfSha256(ikm, salt, 'info-a'))).toBe(hex(a));
    expect(hex(await hkdfSha256(ikm, salt, 'info-b'))).not.toBe(hex(a));
    expect(hex(await hkdfSha256(ikm, randomBytes(16), 'info-a'))).not.toBe(hex(a));
  });

  it('PBKDF2 迭代次数影响派生结果', async () => {
    const secret = randomBytes(16);
    const salt = randomBytes(16);
    expect(hex(await deriveMasterKey(secret, salt, 100))).not.toBe(hex(await deriveMasterKey(secret, salt, 101)));
  });
});

describe('keyfile', () => {
  it('生成/解析往返（新格式，多行 + 指纹）', async () => {
    const seed = randomKeySeed();
    const text = await generateKeyFile(seed);
    expect(text.startsWith(KEY_MAGIC)).toBe(true);
    expect(text).toContain('fingerprint:');
    expect(text.split('\n').length).toBeGreaterThan(4);
    expect(parseKeyFile(text)).toEqual(seed);
  });

  it('非法文件拒绝', () => {
    expect(() => parseKeyFile('hello\nAAAA')).toThrow();
    expect(() => parseKeyFile('IMGVAGUER KEYFILE v1\n--\n!!!')).toThrow();
    expect(() => parseKeyFile('IMGVAGUER KEYFILE v1\n--\nQUJD')).toThrow('密钥长度非法');
  });
});

describe('性能统计', () => {
  it('份额用最大余数法补足到 100', () => {
    expect(shares([1, 1, 1])).toEqual([34, 33, 33]);
    expect(shares([1, 0, 0, 0])).toEqual([100, 0, 0, 0]);
    expect(shares([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('汇总：批级开销 = 总耗时 − 各张耗时之和，且不出现负值', () => {
    const s = summarize({
      op: 'encrypt',
      mode: 'scramble',
      totalMs: 300,
      items: [
        itemStat({ name: 'a.png', inBytes: 100, outBytes: 200, ms: 100, pixels: 1000 }),
        itemStat({ name: 'b.png', inBytes: 100, outBytes: 100, ms: 150, pixels: 2000, ok: false }),
      ],
    });
    expect(s.itemMs).toBe(250);
    expect(s.overheadMs).toBe(50);
    expect(s.avgMs).toBe(125);
    expect(s.maxMs).toBe(150);
    expect(s.slowest?.name).toBe('b.png');
    expect(s.sizeRatio).toBe(1.5);
    expect(s.count).toBe(2);
    expect(s.okCount).toBe(1);
    expect(s.failCount).toBe(1);
    // 时钟精度差异可能让各张之和略大于总耗时，此时开销夹到 0
    const tight = summarize({
      op: 'decrypt',
      mode: null,
      totalMs: 10,
      items: [itemStat({ name: 'a', inBytes: 0, ms: 100 })],
    });
    expect(tight.overheadMs).toBe(0);
  });

  it('构成图切片：批级开销参与归一，份额合计仍为 100', () => {
    const stats = {
      op: 'decrypt' as const,
      mode: null,
      totalMs: 200,
      items: [
        itemStat({
          name: 'a',
          inBytes: 10,
          outBytes: 20,
          ms: 150,
          pixels: 4,
          stages: { kdf: 100, payload: 50, pixels: 0, output: 0 },
        }),
      ],
    };
    const summary = summarize(stats);
    const slices = composeSlices(summary);
    expect(slices.map((s) => s.key)).toEqual(['kdf', 'payload', 'pixels', 'output', 'overhead']);
    expect(slices.reduce((n, s) => n + s.percent, 0)).toBe(100);
    // 最慢的一张条长为满格
    expect(statRows(stats, summary)[0].width).toBe(100);
  });

  it('字节与耗时格式化', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatMs(8)).toBe('8.0 ms');
    expect(formatMs(250)).toBe('250 ms');
    expect(formatMs(2500)).toBe('2.50 s');
  });
});

describe('engine', () => {
  const base = { iterations: 1000 };
  const scramble = (over: Partial<ScrambleParams> = {}): ScrambleParams => ({
    ...base, mode: 'scramble', layout: 'pixel', protection: 'none', password: '', blockSize: 16, noise: 24, ...over,
  });
  const overlay = (over: Partial<OverlayParams> = {}): OverlayParams => ({
    ...base, mode: 'overlay', protection: 'none', password: '', opacity: 1, fit: 'cover', ...over,
  });
  const hybrid = (over: Partial<HybridParams> = {}): HybridParams => ({
    ...base, mode: 'hybrid', protection: 'none', password: '', blockSize: 16, noise: 24, opacity: 1, fit: 'cover', ...over,
  });

  /** 加密输入：字节与位图都按需提供，模拟调用方的懒解码写法 */
  function fileInput(raster: Raster, bytes: Uint8Array, name = 'photo.png'): EncryptInput {
    return {
      name,
      width: raster.width,
      height: raster.height,
      bytes: async () => bytes,
      raster: async () => raster,
    };
  }

  /** 以位图字节充当「原文件」，便于逐位比对 */
  function input(raster: Raster, name = 'photo.png'): EncryptInput {
    return fileInput(raster, Uint8Array.from(raster.data), name);
  }

  /** 还原结果应与对应输入的原文件逐字节一致 */
  async function expectOriginal(restored: DecodedImage[], sources: EncryptInput[]): Promise<void> {
    expect(restored.length).toBe(sources.length);
    for (let i = 0; i < restored.length; i++) {
      expect(restored[i].name).toBe(sources[i].name);
      expect(restored[i].bytes).toEqual(await sources[i].bytes());
    }
  }

  it('像素布局：加密/解密逐位还原（解密输出为位图）', async () => {
    const src = randomRaster(64, 48);
    const out = await encryptImage(input(src), scramble());
    expect(readHeader(out.bytes)?.version).toBe(VERSION);
    expect(out.fields.payloadKind).toBe('mode');
    const [dec] = await decryptImage(out.bytes);
    expect(dec.raster!.data).toEqual(src.data);
    expect(dec.bytes).toBeUndefined();
  });

  it('载荷布局 三种保护：解密直接还原原始文件', async () => {
    const src = opaqueRaster(64, 48);
    const seed = randomKeySeed();
    const cases: { params: ScrambleParams; pass?: string; seed?: Uint8Array }[] = [
      { params: scramble({ layout: 'payload' }) },
      { params: scramble({ layout: 'payload', protection: 'password', password: 'pw' }), pass: 'pw' },
      { params: scramble({ layout: 'payload', protection: 'keyfile' }), seed },
    ];
    for (const c of cases) {
      const source = input(src, '原图.png');
      const out = await encryptImage(source, c.params, [], c.seed);
      expect(out.fields.payloadKind).toBe('file');
      const restored = await decryptImage(out.bytes, c.pass, c.seed);
      await expectOriginal(restored, [source]);
      expect(restored[0].raster).toBeUndefined();
    }
  });

  it('载荷布局：输出体积与原文件相当（装饰图体积受控）', async () => {
    const raster = smoothRaster(600, 450);
    const file = encodePng(raster); // 以位图的 PNG 编码充当原文件
    const out = await encryptImage(fileInput(raster, file), scramble({ layout: 'payload' }));
    expect(out.bytes.length - file.length).toBeLessThan(20 * 1024);
    expect(out.bytes.length).toBeLessThan(file.length * 1.25);
  });

  it('载荷布局：原文件越大，输出越贴近原文件', async () => {
    const raster = randomRaster(400, 300);
    const file = encodePng(raster); // 不可压缩位图 → 较大的「原文件」
    const out = await encryptImage(fileInput(raster, file), scramble({ layout: 'payload' }));
    expect(out.bytes.length).toBeLessThan(file.length * 1.15);
  });

  it('载荷布局：装饰图尺寸独立于原图，不泄露原图尺寸', async () => {
    const src = opaqueRaster(1200, 900);
    const out = await encryptImage(input(src), scramble({ layout: 'payload' }));
    expect(Math.max(out.outRaster.width, out.outRaster.height)).toBe(512);
    expect(out.outRaster.width / out.outRaster.height).toBeCloseTo(4 / 3, 1);
    expect(out.fields.origWidth).toBe(1200); // 真尺寸只存在于加密元数据中
    expect(out.outRaster.data.length).not.toBe(src.data.length);
  });

  it('载荷布局体积显著小于像素布局（原文件为已压缩格式）', async () => {
    const raster = smoothRaster(256, 192);
    const pixel = await encryptImage(input(raster), scramble({ layout: 'pixel' }));
    const payload = await encryptImage(
      fileInput(raster, encodePng(raster)),
      scramble({ layout: 'payload' }),
    );
    expect(payload.bytes.length).toBeLessThan(pixel.bytes.length * 0.5);
  });

  it('载荷布局：可见像素不含原图信息', async () => {
    const src = opaqueRaster(64, 48);
    const out = await encryptImage(input(src), scramble({ layout: 'payload' }));
    expect(out.outRaster.data).not.toEqual(src.data);
  });

  it('去指纹：数据块不含品牌标识与明文参数', async () => {
    const src = randomRaster(48, 48);
    const out = await encryptImage(input(src), scramble({
      protection: 'password', password: 'pw', blockSize: 32, noise: 40,
      rounds: 3, globalPerm: true, sbox: true, rowshift: true,
    }));
    const text = new TextDecoder().decode(extractPngChunk(out.bytes, CHUNK_TYPE)!);
    expect(text).not.toContain('IVGR');
    expect(text).not.toContain('ImgVaguer');
    expect(text).not.toContain('IVGMETA3');
  });

  it('像素布局 口令：正确口令还原，错误口令拒绝', async () => {
    const src = randomRaster(64, 64);
    const out = await encryptImage(input(src), scramble({ protection: 'password', password: 's3cret', blockSize: 8, noise: 8 }));
    expect((await decryptImage(out.bytes, 's3cret'))[0].raster!.data).toEqual(src.data);
    await expect(decryptImage(out.bytes, 'wrong')).rejects.toThrow('口令/密钥错误或数据已损坏');
  });

  it('密钥文件：凭种子还原，缺种子/错种子拒绝', async () => {
    const src = randomRaster(64, 64);
    const seed = randomKeySeed();
    const out = await encryptImage(input(src), scramble({ protection: 'keyfile', blockSize: 16, noise: 16 }), [], seed);
    expect((await decryptImage(out.bytes, undefined, seed))[0].raster!.data).toEqual(src.data);
    await expect(decryptImage(out.bytes)).rejects.toThrow('密钥文件');
    await expect(decryptImage(out.bytes, undefined, randomKeySeed())).rejects.toThrow();
  });

  it('密钥文件：逐图 IV 生效，同种子两次加密不共享密钥流', async () => {
    const src = randomRaster(48, 48);
    const seed = randomKeySeed();
    const params = scramble({ protection: 'keyfile' });
    const a = await encryptImage(input(src), params, [], seed);
    const b = await encryptImage(input(src), params, [], seed);
    expect(a.outRaster.data).not.toEqual(b.outRaster.data);
    expect((await decryptImage(a.bytes, undefined, seed))[0].raster!.data).toEqual(src.data);
    expect((await decryptImage(b.bytes, undefined, seed))[0].raster!.data).toEqual(src.data);
  });

  it('像素布局专业参数经头部自动往返', async () => {
    const src = randomRaster(64, 48);
    const out = await encryptImage(input(src), scramble({
      protection: 'password', password: 'pro', noise: 24,
      rounds: 2, globalPerm: true, sbox: true, rowshift: true,
    }));
    expect((await decryptImage(out.bytes, 'pro'))[0].raster!.data).toEqual(src.data);
  });

  it('overlay 口令：解密直接还原原始文件', async () => {
    const target = randomRaster(48, 48);
    const cover = opaqueRaster(48, 48);
    const source = input(target, 'a.jpg');
    const out = await encryptImage(source, overlay({ protection: 'password', password: 'pw' }), [cover]);
    expect(out.outRaster.data).toEqual(cover.data);
    await expectOriginal(await decryptImage(out.bytes, 'pw'), [source]);
    await expect(decryptImage(out.bytes, 'nope')).rejects.toThrow();
  });

  it('overlay 多层：目标层在顶层时输出含真图，载荷仍还原原文件', async () => {
    const target = opaqueRaster(32, 32);
    const c1 = opaqueRaster(32, 32);
    const source = input(target);
    const out = await encryptImage(source, overlay({ targetLayer: 1 }), [c1]);
    expect(out.outRaster.data).toEqual(target.data);
    await expectOriginal(await decryptImage(out.bytes), [source]);
  });

  it('位图按需解码：载荷布局只取尺寸与字节，像素级布局才解码', async () => {
    const raster = opaqueRaster(32, 32);
    let decoded = 0;
    const lazy = (o: EncryptInput): EncryptInput => ({
      ...o,
      raster: async () => {
        decoded++;
        return raster;
      },
    });
    await encryptImage(lazy(input(raster)), scramble({ layout: 'payload' }));
    expect(decoded).toBe(0);
    await encryptImage(lazy(input(raster)), scramble({ layout: 'pixel' }));
    expect(decoded).toBe(1);
  });

  it('载荷布局：可见像素被改动不影响还原（MAC 覆盖加密载荷而非装饰像素）', async () => {
    const source = input(randomRaster(32, 24), 'a.jpg');
    const out = await encryptImage(source, scramble({ layout: 'payload', protection: 'password', password: 'pw' }));
    const visible: Raster = { ...out.outRaster, data: Uint8ClampedArray.from(out.outRaster.data) };
    visible.data[0] ^= 0xff;
    const tampered = encodePng(visible, { extra: { type: CHUNK_TYPE, data: extractPngChunk(out.bytes, CHUNK_TYPE)! } });
    await expectOriginal(await decryptImage(tampered, 'pw'), [source]);
  });

  it('载荷为原文件：重编码可见图后仍可还原', async () => {
    const src = randomRaster(40, 24);
    const source = input(src);
    const out = await encryptImage(source, scramble({ layout: 'payload', protection: 'password', password: 'pw' }));
    const reencoded = encodePng(out.outRaster, { extra: { type: CHUNK_TYPE, data: extractPngChunk(out.bytes, CHUNK_TYPE)! } });
    await expectOriginal(await decryptImage(reencoded, 'pw'), [source]);
  });

  it('密文认证：像素被改动即拒绝', async () => {
    const src = randomRaster(32, 32);
    const out = await encryptImage(input(src), scramble({ protection: 'password', password: 'pw', noise: 0 }));
    const tampered: Raster = { ...out.outRaster, data: out.outRaster.data.slice() };
    tampered.data[0] ^= 0xff;
    const reencoded = encodePng(tampered, { extra: { type: CHUNK_TYPE, data: extractPngChunk(out.bytes, CHUNK_TYPE)! } });
    await expect(decryptImage(reencoded, 'pw')).rejects.toThrow('数据已损坏');
  });

  it('篡改检测：改动 MAC 任意字节即拒绝', async () => {
    const src = randomRaster(32, 32);
    const out = await encryptImage(input(src), scramble({ protection: 'password', password: 'pw', noise: 0 }));
    const chunk = extractPngChunk(out.bytes, CHUNK_TYPE)!;
    chunk[chunk.length - 1] ^= 0xff;
    await expect(decryptImage(out.bytes, 'pw')).rejects.toThrow('数据已损坏');
  });

  it('篡改检测：改动加密元数据中的载荷形态位即拒绝', async () => {
    const src = randomRaster(32, 32);
    const out = await encryptImage(input(src), scramble({ layout: 'payload', protection: 'password', password: 'pw' }));
    const chunk = extractPngChunk(out.bytes, CHUNK_TYPE)!;
    chunk[1 + 16 + 4 + 32] ^= 0x04; // 翻转 flags 中的载荷形态位
    await expect(decryptImage(out.bytes, 'pw')).rejects.toThrow();
  });

  it('多图合并：解密展开为全部原文件（三种保护均可用）', async () => {
    const first = randomRaster(20, 12);
    const sources = [input(first, 'a.png'), input(randomRaster(10, 30), 'b.jpg'), input(opaqueRaster(16, 16), 'c.webp')];
    const seed = randomKeySeed();
    const params = scramble({ pack: true, protection: 'keyfile', blockSize: 8, noise: 8 });
    const out = await encryptPack(sources, params, [], seed);
    expect(out.outRaster.data).not.toEqual(first.data);
    await expectOriginal(await decryptImage(out.bytes, undefined, seed), sources);

    const noneOut = await encryptPack(sources, { ...params, protection: 'none', password: '' });
    await expectOriginal(await decryptImage(noneOut.bytes), sources);
    const pwOut = await encryptPack(sources, { ...params, protection: 'password', password: 'p' });
    await expectOriginal(await decryptImage(pwOut.bytes, 'p'), sources);
    await expect(decryptImage(pwOut.bytes, 'nope')).rejects.toThrow();
  });

  it('多图合并：输出体积约为各原文件之和（仅多一张装饰图）', async () => {
    const rasters = [smoothRaster(320, 240), randomRaster(200, 150), opaqueRaster(160, 120)];
    const files = rasters.map((r) => encodePng(r));
    const sources = rasters.map((r, i) => fileInput(r, files[i], `p${i}.png`));
    const total = files.reduce((n, f) => n + f.length, 0);
    const out = await encryptPack(sources, scramble({ pack: true, layout: 'payload' }));
    expect(Math.abs(out.bytes.length - total)).toBeLessThan(20 * 1024);
  });

  it('多图合并 + 载荷布局：可见图为装饰噪声', async () => {
    const first = opaqueRaster(24, 24);
    const sources = [input(first, 'x.png'), input(opaqueRaster(24, 24), 'y.png')];
    const seed = randomKeySeed();
    const out = await encryptPack(sources, scramble({ pack: true, layout: 'payload', protection: 'keyfile' }), [], seed);
    expect(out.outRaster.data).not.toEqual(first.data);
    await expectOriginal(await decryptImage(out.bytes, undefined, seed), sources);
  });

  it('混合方式：可见图为密文底图叠覆盖层，还原仍为原始文件', async () => {
    const raster = randomRaster(24, 24);
    const source = fileInput(raster, encodePng(raster), 'h.png');
    const cover = opaqueRaster(24, 24);
    const seed = randomKeySeed();
    const out = await encryptImage(source, hybrid(), [cover], seed);
    expect(out.fields.mode).toBe('hybrid');
    // 可见像素被覆盖层改写，故载荷必须是原始文件字节才能无损还原
    expect(out.fields.payloadKind).toBe('file');
    expect(out.outRaster.data).toEqual(cover.data);
    await expectOriginal(await decryptImage(out.bytes, undefined, seed), [source]);
  });

  it('混合方式：半透明覆盖之下是密文噪声，而非原图像素', async () => {
    const raster = randomRaster(24, 24);
    const source = fileInput(raster, encodePng(raster), 'h.png');
    const cover = opaqueRaster(24, 24);
    const seed = randomKeySeed();
    // 同一枚种子：盐与 IV 相同，两种方式的差异只来自「底图是否被混淆」
    const mixed = await encryptImage(source, hybrid({ opacity: 0.5 }), [cover], seed);
    const plain = await encryptImage(source, overlay({ opacity: 0.5 }), [cover], seed);
    expect(mixed.outRaster.data).not.toEqual(plain.outRaster.data);
    await expectOriginal(await decryptImage(mixed.bytes, undefined, seed), [source]);
  });

  it('混合方式：缺少覆盖图时明确报错', async () => {
    const raster = opaqueRaster(8, 8);
    await expect(encryptImage(fileInput(raster, encodePng(raster)), hybrid())).rejects.toThrow('覆盖图');
  });

  it('多图合并（覆盖合成）：遮盖图不参与还原', async () => {
    const first = randomRaster(24, 24);
    const sources = [input(first, 'x.png'), input(randomRaster(24, 24), 'y.png')];
    const cover = opaqueRaster(24, 24);
    const seed = randomKeySeed();
    const out = await encryptPack(sources, overlay({ pack: true, protection: 'keyfile' }), [cover], seed);
    expect(out.outRaster.data).toEqual(cover.data);
    await expectOriginal(await decryptImage(out.bytes, undefined, seed), sources);
  });

  it('非法迭代次数拒绝', async () => {
    const src = randomRaster(8, 8);
    await expect(encryptImage(input(src), scramble({ iterations: 0 }))).rejects.toThrow('非法的迭代次数');
    await expect(encryptImage(input(src), scramble({ iterations: 20_000_000 }))).rejects.toThrow('非法的迭代次数');
  });

  it('覆盖图尺寸不一致拒绝', async () => {
    const src = randomRaster(16, 16);
    await expect(encryptImage(input(src), overlay(), [opaqueRaster(8, 8)])).rejects.toThrow('尺寸需与目标一致');
  });
});
