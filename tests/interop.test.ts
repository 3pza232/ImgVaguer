/**
 * 两端互操作与同源校验。
 *
 * 桌面端与移动端共用同一套算法层，只有三处必须按平台分叉
 * （纯 TS 加密原语、内置 Base64、fflate 引用路径）。
 * 这层一旦悄悄分叉，最典型的后果是「一端加密、另一端解不开」——
 * 而两端各自的静态检查与单测都发现不了：它们各自都自洽。
 *
 * 因此本文件用两条互补的规则把它钉住：
 *   1) 共用文件必须逐字节相同，且「两端都存在」的文件必须显式登记（新增文件不会被漏掉）；
 *   2) 分叉文件的输出必须与桌面端一致——同一输入给同一结果。
 * 有了这两条，「桌面加密 → 移动解密」由构造成立，不必在测试里跑完整引擎；
 * 反过来，只要有人改动了线格式相关的共用文件或分叉实现，这里会先红。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CHUNK_TYPE, EMBEDDED_INFO, KEYFILE_INFO, VERSION } from '@/core/header';
import { deriveMasterKey, deriveSubKeys, hkdfSha256, passwordBytes } from '@/core/kdf';
import { generateKeyFile, parseKeyFile } from '@/core/keyfile';
import { decodePngRgba, encodePng, extractPngChunk } from '@/core/png';
import type { Raster } from '@/core/types';

import {
  deriveMasterKey as mDeriveMasterKey,
  deriveSubKeys as mDeriveSubKeys,
  hkdfSha256 as mHkdfSha256,
} from '../uniapp/ImgVaguer/core/kdf';
import {
  generateKeyFile as mGenerateKeyFile,
  parseKeyFile as mParseKeyFile,
} from '../uniapp/ImgVaguer/core/keyfile';
import {
  decodePngRgba as mDecodePngRgba,
  encodePng as mEncodePng,
  extractPngChunk as mExtractPngChunk,
} from '../uniapp/ImgVaguer/core/png';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DESKTOP_CORE = join(ROOT, 'src', 'core');
const MOBILE_CORE = join(ROOT, 'uniapp', 'ImgVaguer', 'core');

/** 必须逐字节相同的共用文件 */
const SHARED = [
  'chacha.ts',
  'decoy.ts',
  'header.ts',
  'overlay.ts',
  'pack.ts',
  'params.ts',
  'scramble.ts',
  'stats.ts',
  'text.ts',
  'types.ts',
];

/**
 * 按平台分叉的文件：差异是有意的（WebCrypto 对纯 TS、btoa 对内置实现、fflate 引用路径不同）。
 * 输出一致性由下面的互操作用例保证；若哪天真的统一了实现，把它移到 SHARED 即可。
 */
const FORKED = ['kdf.ts', 'keyfile.ts', 'png.ts'];

const coreFiles = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.ts'));

describe('两端同源校验', () => {
  it('登记表覆盖了所有两端都存在的 core 文件', () => {
    const mobile = new Set(coreFiles(MOBILE_CORE));
    const both = coreFiles(DESKTOP_CORE).filter((f) => mobile.has(f)).sort();
    expect(both).toEqual([...SHARED, ...FORKED].sort());
  });

  it('共用文件逐字节相同', () => {
    for (const name of SHARED) {
      expect(readFileSync(join(MOBILE_CORE, name)), `${name} 应两端同源`).toEqual(
        readFileSync(join(DESKTOP_CORE, name)),
      );
    }
  });

  it('分叉文件确实有差异（统一实现后应从 FORKED 移到 SHARED）', () => {
    for (const name of FORKED) {
      expect(
        readFileSync(join(MOBILE_CORE, name)),
        `${name} 与桌面端已完全相同，请把它从 FORKED 移到 SHARED`,
      ).not.toEqual(readFileSync(join(DESKTOP_CORE, name)));
    }
  });
});

describe('分叉文件的互操作（同一输入 → 同一结果）', () => {
  const salt = Uint8Array.from({ length: 16 }, (_, i) => (i * 7 + 3) & 0xff);
  const seed = Uint8Array.from({ length: 32 }, (_, i) => (255 - i * 5) & 0xff);
  /** 迭代次数取小值：这里验证的是两条实现是否一致，而不是强度 */
  const ITER = 1000;

  it('口令派生：两端得到同一组子密钥', async () => {
    const desktop = await deriveSubKeys(await deriveMasterKey(passwordBytes('口令 pass phrase'), salt, ITER));
    const mobile = await mDeriveSubKeys(await mDeriveMasterKey(passwordBytes('口令 pass phrase'), salt, ITER));
    expect(mobile).toEqual(desktop);
  });

  it('全熵凭据派生：HKDF 域标签两端一致，且随线格式版本走', async () => {
    for (const info of [KEYFILE_INFO, EMBEDDED_INFO]) {
      expect(await mHkdfSha256(seed, salt, info)).toEqual(await hkdfSha256(seed, salt, info));
      expect(info, '域标签应随 VERSION 一起更新').toContain(`v${VERSION}`);
    }
  });

  it('密钥文件：一端生成的 .ivkey 能被另一端解析回同一种子', async () => {
    expect([...mParseKeyFile(await generateKeyFile(seed))]).toEqual([...seed]);
    expect([...parseKeyFile(await mGenerateKeyFile(seed))]).toEqual([...seed]);
  });

  it('密钥文件：被篡改的内容两端一致地拒绝', async () => {
    const lines = (await generateKeyFile(seed)).split('\n');
    const broken = [...lines.slice(0, -1), 'AAAA'].join('\n');
    expect(() => parseKeyFile(broken)).toThrow();
    expect(() => mParseKeyFile(broken)).toThrow();
  });

  it('PNG：一端的编码能被另一端逐位解码（含私有数据块）', () => {
    // 两种编码路径都要验：全不透明走 RGB（解码端需补回 alpha=255），含透明像素走 RGBA
    for (const raster of [opaqueRaster(6, 4), alphaRaster(5, 3)]) {
      const extra = { type: CHUNK_TYPE, data: Uint8Array.from([9, 8, 7, 6, 5]) };

      const fromDesktop = encodePng(raster, { extra });
      expect([...mDecodePngRgba(fromDesktop).data]).toEqual([...raster.data]);
      expect([...(mExtractPngChunk(fromDesktop, CHUNK_TYPE) ?? [])]).toEqual([...extra.data]);

      const fromMobile = mEncodePng(raster, { extra });
      expect([...decodePngRgba(fromMobile).data]).toEqual([...raster.data]);
      expect([...(extractPngChunk(fromMobile, CHUNK_TYPE) ?? [])]).toEqual([...extra.data]);
    }
  });
});

/** 全不透明位图：会被按 RGB 编码 */
function opaqueRaster(width: number, height: number): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i * 3) & 0xff;
    data[i + 1] = (i * 5) & 0xff;
    data[i + 2] = (i * 7) & 0xff;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/** 含透明像素的位图：走 RGBA 编码路径 */
function alphaRaster(width: number, height: number): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i * 11) & 0xff;
    data[i + 1] = (i * 13) & 0xff;
    data[i + 2] = (i * 17) & 0xff;
    data[i + 3] = i % 8 === 0 ? 0 : (i * 2) & 0xff;
  }
  return { width, height, data };
}
