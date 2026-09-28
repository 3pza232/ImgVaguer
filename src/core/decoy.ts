/**
 * 装饰图：密文混淆「载荷布局」下的可见像素。
 *
 * 该布局中原图以加密载荷存放，可见像素不承载任何信息，只负责给出「噪声状图像」的观感，
 * 因而有两处自由度可用来把输出体积压到与原文件相当：
 *  1. 尺寸独立于原图——按长边缩至上限内，同时避免在用图像尺寸泄露原图尺寸；
 *  2. 按块填充——观感与逐像素噪声无异，deflate 却能压缩两个数量级。
 * 块边长再按载荷体积反解，使装饰图体积受控：既不喧宾夺主，也不退化成逐像素噪声。
 */
import { ChaCha20, ivNonce } from './chacha';
import type { Raster } from './types';

/** 装饰图长边上限 */
const DECOY_MAX_EDGE = 512;
/** 装饰图压缩后的体积上限 */
const DECOY_MAX_BYTES = 16 * 1024;
/** 装饰图体积占载荷的比例上限 */
const DECOY_RATIO = 1 / 12;
/** 装饰图体积下限：过小会让块粗到不成噪声 */
const DECOY_MIN_BYTES = 1024;
/** 块边长下限 */
const DECOY_MIN_BLOCK = 4;
/** 实测关系：B×B 块状噪声经 PNG 滤波 + 压缩后约为 6/B² 字节每像素 */
const DECOY_BYTES_PER_BLOCK = 6;

/**
 * nonce 域分配：0=载荷 / 1..8+16r=像素变换管线 / 200=元数据 / 201=装饰图。
 * 该域不参与任何可逆变换，仅用于让装饰图案随密钥与逐图 IV 变化。
 */
const DECOY_DOMAIN = 201;

/** 装饰图尺寸：按长边等比缩至上限内 */
function decoySize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, DECOY_MAX_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** 按装饰图尺寸与载荷体积反解块边长，使装饰图体积落在预算内 */
function decoyBlock(width: number, height: number, payloadBytes: number): number {
  const budget = Math.min(DECOY_MAX_BYTES, Math.max(payloadBytes * DECOY_RATIO, DECOY_MIN_BYTES));
  const block = Math.sqrt((DECOY_BYTES_PER_BLOCK * width * height) / budget);
  return Math.max(DECOY_MIN_BLOCK, Math.round(block));
}

export function decoyRaster(width: number, height: number, payloadBytes: number, key: Uint8Array, iv: Uint8Array): Raster {
  const { width: w, height: h } = decoySize(width, height);
  const block = decoyBlock(w, h, payloadBytes);
  const bw = Math.ceil(w / block);
  const bh = Math.ceil(h / block);
  const noise = new Uint8Array(bw * bh * 3);
  new ChaCha20(key, ivNonce(iv, DECOY_DOMAIN)).streamInto(noise, 0, noise.length);

  const data = new Uint8ClampedArray(w * h * 4);
  for (let by = 0; by < bh; by++) {
    const yEnd = Math.min(h, (by + 1) * block);
    for (let bx = 0; bx < bw; bx++) {
      const xEnd = Math.min(w, (bx + 1) * block);
      const s = (by * bw + bx) * 3;
      const r = noise[s];
      const g = noise[s + 1];
      const b = noise[s + 2];
      for (let y = by * block; y < yEnd; y++) {
        for (let x = bx * block; x < xEnd; x++) {
          const d = (y * w + x) * 4;
          data[d] = r;
          data[d + 1] = g;
          data[d + 2] = b;
          data[d + 3] = 255;
        }
      }
    }
  }
  return { width: w, height: h, data };
}
