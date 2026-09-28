/**
 * 纯 TS 位图重采样（双线性）：替代 canvas 缩放。
 * 保证 H5 / App / 小程序行为一致，不引入平台画布依赖，且结果可预测可测试。
 */
import type { Raster } from './types';

/** 目标 → 源的线性映射（半像素对齐，与浏览器缩放观感一致） */
interface Axis {
  from: number;
  step: number;
}

function resample(src: Raster, dw: number, dh: number, ax: Axis, ay: Axis): Raster {
  const sw = src.width;
  const sh = src.height;
  const sd = src.data;
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = ay.from + y * ay.step;
    const y0 = Math.min(Math.max(Math.floor(sy), 0), sh - 1);
    const y1 = Math.min(y0 + 1, sh - 1);
    const fy = Math.min(Math.max(sy - y0, 0), 1);
    for (let x = 0; x < dw; x++) {
      const sx = ax.from + x * ax.step;
      const x0 = Math.min(Math.max(Math.floor(sx), 0), sw - 1);
      const x1 = Math.min(x0 + 1, sw - 1);
      const fx = Math.min(Math.max(sx - x0, 0), 1);
      const i00 = (y0 * sw + x0) * 4;
      const i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const d = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = sd[i00 + c] + (sd[i01 + c] - sd[i00 + c]) * fx;
        const bot = sd[i10 + c] + (sd[i11 + c] - sd[i10 + c]) * fx;
        out[d + c] = top + (bot - top) * fy + 0.5;
      }
    }
  }
  return { width: dw, height: dh, data: out };
}

function axis(srcLen: number, dstLen: number, offset = 0, span = srcLen): Axis {
  const step = span / dstLen;
  return { from: offset + step * 0.5 - 0.5, step };
}

/** 直接拉伸到目标尺寸 */
export function stretchRaster(src: Raster, w: number, h: number): Raster {
  if (src.width === w && src.height === h) return src;
  return resample(src, w, h, axis(src.width, w), axis(src.height, h));
}

/** 适配目标尺寸：cover 等比填充并居中裁剪，stretch 直接拉伸 */
export function fitRaster(src: Raster, w: number, h: number, fit: 'cover' | 'stretch'): Raster {
  if (src.width === w && src.height === h) return src;
  if (fit === 'stretch') return stretchRaster(src, w, h);
  const scale = Math.max(w / src.width, h / src.height);
  const cropW = Math.min(w / scale, src.width);
  const cropH = Math.min(h / scale, src.height);
  return resample(
    src,
    w,
    h,
    axis(src.width, w, (src.width - cropW) / 2, cropW),
    axis(src.height, h, (src.height - cropH) / 2, cropH),
  );
}

/** 降采样再放大以削弱细节（用于覆盖层压缩）；q=1 原样返回 */
export function degradeRaster(src: Raster, q: number): Raster {
  if (q >= 1) return src;
  const w = Math.max(1, Math.round(src.width * q));
  const h = Math.max(1, Math.round(src.height * q));
  return stretchRaster(stretchRaster(src, w, h), src.width, src.height);
}

/** 等比缩小至最长边 maxEdge（缩略图用） */
export function thumbRaster(src: Raster, maxEdge = 256): Raster {
  const k = Math.min(1, maxEdge / Math.max(src.width, src.height));
  if (k >= 1) return src;
  return stretchRaster(src, Math.max(1, Math.round(src.width * k)), Math.max(1, Math.round(src.height * k)));
}
