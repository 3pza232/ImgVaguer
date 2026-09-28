/** 图像 IO：文件解码、缩放、预览、下载（DOM 层） */
import type { Raster } from '@/core/types';

/**
 * 仅取尺寸而不取像素。
 * 载荷布局与多图合并只需要尺寸，读一次像素图要付出整幅 RGBA 的分配与拷贝。
 */
export async function fileToSize(file: Blob): Promise<{ width: number; height: number }> {
  const bmp = await createImageBitmap(file);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return size;
}

export async function fileToRaster(file: Blob): Promise<Raster> {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: img.width, height: img.height, data: img.data };
}

export function rasterToUrl(r: Raster): string {
  const canvas = document.createElement('canvas');
  canvas.width = r.width;
  canvas.height = r.height;
  canvas.getContext('2d')!.putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
  return canvas.toDataURL('image/png');
}

/** 将 cover 缩放至目标尺寸；cover 模式保持比例居中裁剪，stretch 直接拉伸 */
export function resizeRaster(src: Raster, w: number, h: number, fit: 'cover' | 'stretch'): Raster {
  const sc = document.createElement('canvas');
  sc.width = src.width;
  sc.height = src.height;
  sc.getContext('2d')!.putImageData(new ImageData(src.data, src.width, src.height), 0, 0);

  const dc = document.createElement('canvas');
  dc.width = w;
  dc.height = h;
  const ctx = dc.getContext('2d')!;
  if (fit === 'stretch') {
    ctx.drawImage(sc, 0, 0, w, h);
  } else {
    const scale = Math.max(w / src.width, h / src.height);
    const sw = w / scale;
    const sh = h / scale;
    ctx.drawImage(sc, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, w, h);
  }
  const img = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: img.data };
}

/** 降低覆盖层细节（缩小再放回），减小输出 PNG 体积；q=1 时原样返回 */
export function degradeRaster(src: Raster, q: number): Raster {
  if (q >= 1) return src;
  const w = Math.max(1, Math.round(src.width * q));
  const h = Math.max(1, Math.round(src.height * q));
  const sc = document.createElement('canvas');
  sc.width = src.width;
  sc.height = src.height;
  sc.getContext('2d')!.putImageData(new ImageData(src.data, src.width, src.height), 0, 0);
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  small.getContext('2d')!.drawImage(sc, 0, 0, w, h);
  const back = document.createElement('canvas');
  back.width = src.width;
  back.height = src.height;
  const ctx = back.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, src.width, src.height);
  const img = ctx.getImageData(0, 0, src.width, src.height);
  return { width: src.width, height: src.height, data: img.data };
}

export function downloadBytes(bytes: Uint8Array, filename: string, mime = 'image/png'): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
