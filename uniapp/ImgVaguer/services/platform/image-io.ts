/**
 * 图像 IO（平台适配）：选图、解码、预览源、文件读写。
 *
 * 选图阶段只探测尺寸，位图推迟到真正需要时再解码（probeImage / decodeRaster）。
 * 解码：格式由 uni.getImageInfo 的 type 判定——PNG 走自研无损解码器（逐位精确），
 * 其余走平台画布；避免为嗅探格式而把整个（可能很大的）非 PNG 文件读成字节。
 * 预览：选图得到的图像直接以原路径为显示源，不再为预览解码编码一遍；
 * 解码结果按平台给出显示通道，放大预览走应用内浮层。
 */
import { fromBase64 } from '@/core/base64';
// toBase64 仅非小程序预览源使用（小程序写临时文件后返回路径）
// #ifndef MP-WEIXIN
import { toBase64 } from '@/core/base64';
// #endif
import { pickImageName, type ImageFormat } from '@/core/image-format';
import { decodePngRgba, encodePng, isPng } from '@/core/png';
import type { Raster } from '@/core/types';
// #ifdef APP-PLUS
import { writePrivateFileUrl } from './app-storage';
// #endif
// #ifndef H5
import { resizeCanvas } from './canvas-box';
// #endif

// #ifndef H5
/** 画布解码的总像素上限：容纳常见手机照片，超出则内存/耗时不可控 */
const CANVAS_MAX_PIXELS = 20_000_000;

/**
 * 画布单块尺寸。
 *
 * 原生画布（App / 小程序）的绘图区不能超过屏幕：超出部分的绘制直接丢失，
 * 读回只剩左上角一块。故整幅解码必须按屏幕分块，且尺寸只设定一次、全程复用——
 * 逐块重建原生画布会让绘制落在旧绘图区上，同样只解出左上角。
 */
function canvasTile(): { width: number; height: number } {
  const info = uni.getSystemInfoSync();
  return {
    width: Math.max(1, Math.floor(info.windowWidth)),
    height: Math.max(1, Math.floor(info.windowHeight)),
  };
}
// #endif

/** 结果图预览边长：完整像素留在结果字节里，此处只取够看的尺寸 */
export const PREVIEW_EDGE = 1280;

export interface ProbedImage {
  name: string;
  path: string;
  width: number;
  height: number;
}

export interface PickedFile {
  path: string;
  size: number;
  /** 选择器给出的原始文件名（H5 可得；App/小程序为临时路径，通常不提供） */
  name?: string;
}

/**
 * 选图（含文件大小，供大小上限校验使用）。
 * 原始文件名各端能力不一：H5 由选择器给出 name，App/小程序仅返回临时路径，
 * 故 name 可能缺省，由 probeImage 的兜底命名补足。
 */
export function chooseImagesWithMeta(count = 9): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    uni.chooseImage({
      count,
      sizeType: ['original'],
      sourceType: ['album'],
      success: (res: {
        tempFiles?: { path?: string; tempFilePath?: string; size?: number; name?: string }[];
      }) => {
        const files = res.tempFiles ?? [];
        resolve(
          files
            .map((f) => ({
              path: f.path ?? f.tempFilePath ?? '',
              size: f.size ?? 0,
              name: typeof f.name === 'string' && f.name ? f.name : undefined,
            }))
            .filter((f) => !!f.path),
        );
      },
      fail: () => resolve([]),
    });
  });
}

/** 路径基名；仅作日志与缺省展示用（临时路径常无扩展名，此时返回兜底名） */
export function fileNameOf(path: string, fallback = 'image.png'): string {
  const seg = path.split(/[\\/]/).pop() ?? '';
  return seg.includes('.') ? seg : fallback;
}

interface ImageInfo {
  width: number;
  height: number;
  format: ImageFormat | null;
}

function normalizeType(type: string | undefined): ImageFormat | null {
  const t = (type ?? '').toLowerCase();
  if (t === 'png') return 'png';
  if (t === 'jpg' || t === 'jpeg') return 'jpg';
  if (t === 'gif') return 'gif';
  if (t === 'webp') return 'webp';
  if (t === 'bmp') return 'bmp';
  return null;
}

function imageInfo(path: string): Promise<ImageInfo> {
  return new Promise((resolve, reject) => {
    uni.getImageInfo({
      src: path,
      success: (res: { width: number; height: number; type?: string }) =>
        resolve({ width: res.width, height: res.height, format: normalizeType(res.type) }),
      fail: () => reject(new Error('无法读取图像信息')),
    });
  });
}

/** 读取文件字节（H5: fetch；小程序: FileSystemManager；App: plus.io） */
export function readFileBytes(path: string): Promise<Uint8Array> {
  // #ifdef H5
  return fetch(path)
    .then((res) => res.arrayBuffer())
    .then((buf) => new Uint8Array(buf));
  // #endif
  // #ifdef MP-WEIXIN
  return Promise.resolve(new Uint8Array(wx.getFileSystemManager().readFileSync(path) as ArrayBuffer));
  // #endif
  // #ifdef APP-PLUS
  return readAppBytes(path);
  // #endif
}

// #ifdef APP-PLUS
/** 用 plus.io 解析路径并读取为 base64 → 字节 */
function readViaPlus(target: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    plus.io.resolveLocalFileSystemURL(
      target,
      (entry: { file: (ok: (file: unknown) => void, err: () => void) => void }) => {
        entry.file(
          (file) => {
            const reader = new plus.io.FileReader();
            reader.onloadend = (e: { target: { result: string } }) => {
              resolve(fromBase64(String(e.target.result).split(',')[1] ?? ''));
            };
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsDataURL(file as never);
          },
          () => reject(new Error('文件读取失败')),
        );
      },
      () => reject(new Error('文件不存在')),
    );
  });
}

/** 将临时文件保存到应用沙盒后再读（规避部分相册路径受存储沙盒限制不可读） */
async function saveThenRead(path: string): Promise<Uint8Array> {
  const saved = await new Promise<string>((resolve, reject) => {
    uni.saveFile({
      tempFilePath: path,
      success: (res: { savedFilePath: string }) => resolve(res.savedFilePath),
      fail: () => reject(new Error('保存临时文件失败')),
    });
  });
  try {
    const bytes = await readViaPlus(saved);
    try {
      uni.removeSavedFile({ filePath: saved, fail: () => undefined });
    } catch {
      // 旧版本无 removeSavedFile：忽略
    }
    return bytes;
  } catch (e) {
    throw e as Error;
  }
}

/** App 端读取：临时路径形态各版本不一，按候选路径逐一尝试并逐级兜底 */
async function readAppBytes(path: string): Promise<Uint8Array> {
  const candidates = [path];
  if (path.startsWith('file://')) candidates.push(path.slice('file://'.length));
  else candidates.push(`file://${path}`);
  let last: Error = new Error('文件读取失败');
  for (const target of candidates) {
    try {
      return await readViaPlus(target);
    } catch (e) {
      last = e as Error;
    }
  }
  try {
    return await readViaPlus(plus.io.convertLocalFileSystemURL(path));
  } catch {
    // 继续尝试沙盒转存
  }
  try {
    return await saveThenRead(path);
  } catch {
    throw last;
  }
}
// #endif

// ── 画布解码（非 PNG 回退） ──

// #ifdef H5
async function decodeByCanvas(path: string, size: { width: number; height: number }): Promise<Raster> {
  const g = globalThis as unknown as {
    Image: new () => HTMLImageElement;
    document: { createElement(tag: string): HTMLCanvasElement };
  };
  const img = new g.Image();
  img.src = path;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('图像解码失败'));
  });
  const canvas = g.document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画布不可用');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, size.width, size.height);
  return { width: size.width, height: size.height, data: new Uint8ClampedArray(data.data.buffer) };
}
// #endif

// #ifndef H5
/**
 * 画布解码（非 PNG 回退）：按屏幕尺寸分块绘制后拼回整幅。
 * 整幅一次绘制时，超出画布绘图区的部分会被丢掉，结果就是只解出左上角一块。
 */
async function decodeByCanvas(path: string, size: { width: number; height: number }): Promise<Raster> {
  const { width, height } = size;
  if (width * height > CANVAS_MAX_PIXELS) {
    throw new Error(`非 PNG 图像过大（${width}x${height}），请先在相册裁剪压缩，或改用 PNG / 桌面端处理`);
  }
  // 画布尺寸只设定一次并全程复用，之后每块都是一次独立绘制
  const box = canvasTile();
  await resizeCanvas(Math.min(box.width, width), Math.min(box.height, height));
  const ctx = uni.createCanvasContext('vg-canvas');
  const out = new Uint8ClampedArray(width * height * 4);
  for (let ty = 0; ty < height; ty += box.height) {
    const th = Math.min(box.height, height - ty);
    for (let tx = 0; tx < width; tx += box.width) {
      const tw = Math.min(box.width, width - tx);
      // draw() 默认清空画布，故每块都是一次独立绘制
      ctx.drawImage(path, tx, ty, tw, th, 0, 0, tw, th);
      await new Promise<void>((resolve) => ctx.draw(false, () => resolve()));
      const tile = await new Promise<Uint8ClampedArray>((resolve, reject) => {
        uni.canvasGetImageData({
          canvasId: 'vg-canvas',
          x: 0,
          y: 0,
          width: tw,
          height: th,
          success: (res: { data: Uint8ClampedArray }) => resolve(new Uint8ClampedArray(res.data)),
          fail: (e: { errMsg?: string }) => reject(new Error(e.errMsg ?? '读取像素失败')),
        });
      });
      for (let y = 0; y < th; y++) {
        const from = y * tw * 4;
        out.set(tile.subarray(from, from + tw * 4), ((ty + y) * width + tx) * 4);
      }
    }
  }
  return { width, height, data: out };
}
// #endif

/** 解码：PNG 走无损解码器；其余走画布。格式未知时回退读字节嗅探。 */
async function decodePath(
  path: string,
  info: ImageInfo,
): Promise<{ raster: Raster; format: ImageFormat | null }> {
  if (info.format === 'png' || info.format === null) {
    try {
      const bytes = await readFileBytes(path);
      if (isPng(bytes)) return { raster: decodePngRgba(bytes), format: 'png' };
    } catch {
      // 读取失败 → 回退画布
    }
  }
  return { raster: await decodeByCanvas(path, info), format: info.format };
}

/**
 * 探测图像：只取尺寸与命名，不做像素解码。
 * 命名优先级：选择器给出的原始名 → 路径基名（带图像扩展名）→ 兜底名
 * （各端临时路径普遍不含原始文件名，兜底名用于保证列表与导出不重名）。
 * 载荷布局与多图合并只需要尺寸，选图阶段不解码可让批量大图的内存与耗时都可忽略。
 */
export async function probeImage(path: string, name?: string): Promise<ProbedImage> {
  const info = await imageInfo(path);
  return { name: pickImageName(name, path, info.format), path, width: info.width, height: info.height };
}

/** 按需解码位图：像素级布局 / 覆盖合成 / 默认混淆图使用 */
export async function decodeRaster(path: string): Promise<Raster> {
  return (await decodePath(path, await imageInfo(path))).raster;
}

/**
 * 位图 → 可显示的预览源。
 * H5 / App 用 data URL（`<image>` 均支持）；小程序写用户目录并返回路径。
 * 注意：不要把它交给 uni.previewImage（App 端吃 data URL 会崩溃），
 * 放大预览统一走应用内浮层（components/ImageZoom.vue）。
 */
export async function rasterToSrc(raster: Raster): Promise<string> {
  const bytes = encodePng(raster);
  // #ifdef MP-WEIXIN
  return writeTempFile(bytes, `vg-preview-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
  // #endif
  // #ifndef MP-WEIXIN
  return `data:image/png;base64,${toBase64(bytes)}`;
  // #endif
}

// #ifndef H5
/** 预览文件名：唯一且保留原扩展名（App 与小程序的 <image> 依赖扩展名渲染） */
function previewName(name: string): string {
  const ext = (name.match(/\.(\w+)$/)?.[1] ?? 'png').toLowerCase();
  return `vg-restored-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
}
// #endif

/**
 * 还原结果 → 可显示的预览源。
 * 载荷级布局下还原的是**原始文件**（可能是 jpg / png / webp 等任意格式），
 * 无法再由位图重新编码，故按平台给出显示通道：H5 用 Blob URL，
 * App 写入应用私有目录、小程序写入用户目录后返回本地路径。
 */
export async function bytesToSrc(bytes: Uint8Array, name: string): Promise<string> {
  // #ifdef H5
  void name;
  return URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
  // #endif
  // #ifdef APP-PLUS
  return writePrivateFileUrl(previewName(name), bytes);
  // #endif
  // #ifdef MP-WEIXIN
  return writeTempFile(bytes, previewName(name));
  // #endif
}

/** 写入小程序用户目录并返回路径（其它平台无此必要，返回空串） */
export function writeTempFile(bytes: Uint8Array, name: string): string {
  // #ifdef MP-WEIXIN
  const fs = wx.getFileSystemManager();
  const path = `${wx.env.USER_DATA_PATH}/${name}`;
  fs.writeFileSync(path, bytes.buffer as ArrayBuffer);
  return path;
  // #endif
  // #ifndef MP-WEIXIN
  void bytes;
  void name;
  return '';
  // #endif
}

/** 默认混淆图：持久化时统一存为 PNG，故此处仅做无损解码 */
export async function rasterFromDataUrl(dataUrl: string): Promise<Raster> {
  const bytes = fromBase64(dataUrl.split(',')[1] ?? '');
  if (!isPng(bytes)) throw new Error('默认混淆图格式不受支持');
  return decodePngRgba(bytes);
}
