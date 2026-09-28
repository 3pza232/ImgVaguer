/** 用户动作：批量加密 / 批量解密 / 密钥文件 / 覆盖层 / 下载 */
import { generateKeyFile, parseKeyFile, randomKeySeed } from '@/core/keyfile';
import { encodePng } from '@/core/png';
import type { ImgVaguerParams, Raster } from '@/core/types';
import { detail, log, saveSettings, settings, store, type CoverItem, type KeyFileRef, type ResultBatch, type ResultItem, type TargetItem } from '@/stores/session';
import { zipSync } from 'fflate';
import { decryptImage, encryptImage, encryptPack, readHeader, type EncryptInput } from './engine';
import { degradeRaster, downloadBytes, fileToRaster, fileToSize, rasterToUrl, resizeRaster } from './image-io';

function buildParams(): ImgVaguerParams {
  const base = {
    protection: store.protection,
    password: store.password,
    iterations: store.iterations,
    pack: store.pack,
  };
  return store.mode === 'scramble'
    ? {
        ...base,
        mode: 'scramble',
        layout: store.layout,
        blockSize: store.blockSize,
        noise: store.noise,
        rounds: store.rounds,
        globalPerm: store.globalPerm,
        sbox: store.sbox,
        rowshift: store.rowshift,
      }
    : {
        ...base,
        mode: 'overlay',
        opacity: store.opacity,
        fit: store.fit,
        targetLayer: store.targetLayer,
        coverQuality: store.coverQuality,
      };
}

function suffixed(name: string, suffix: string): string {
  return name.replace(/\.\w+$/, '') + suffix;
}

/** 按扩展名推断 MIME：还原结果的格式跟随原文件，不能再假定为 PNG */
function mimeOf(name: string): string {
  const ext = (name.match(/\.(\w+)$/)?.[1] ?? '').toLowerCase();
  const known: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
    ivkey: 'application/octet-stream', zip: 'application/zip',
  };
  return known[ext] ?? 'application/octet-stream';
}

/** 原始文件字节 → 预览地址（浏览器经内容嗅探即可渲染） */
function blobUrl(bytes: Uint8Array): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart]));
}

/**
 * 加密输入：字节与位图都按需获取。
 * 载荷布局与多图合并只索取尺寸与字节，位图解码器因此不会被调用。
 */
function inputOf(t: TargetItem): EncryptInput {
  return {
    name: t.name,
    width: t.width,
    height: t.height,
    bytes: async () => new Uint8Array(await t.file.arrayBuffer()),
    raster: () => fileToRaster(t.file),
  };
}

export async function addTargets(files: File[]): Promise<void> {
  for (const file of files) {
    if (store.targets.length >= settings.maxTargets) {
      log(`目标图像已达上限 ${settings.maxTargets} 张（可在设置中调整）`);
      break;
    }
    try {
      const size = await fileToSize(file);
      if (size.width * size.height > settings.maxPixels) {
        log(`跳过 ${file.name}: ${size.width}x${size.height} 超过像素上限 ${(settings.maxPixels / 10000).toFixed(0)} 万（可在设置中调整）`);
        continue;
      }
      store.targets.push({ name: file.name, file, url: URL.createObjectURL(file), ...size });
      log(`载入 ${file.name} (${size.width}x${size.height})`);
    } catch {
      log(`跳过 ${file.name}: 无法解码`);
    }
  }
}

/** 添加覆盖图层（上限由设置决定） */
export async function addCovers(files: File[]): Promise<void> {
  const max = settings.maxCoverLayers;
  for (const file of files) {
    if (store.covers.length >= max) {
      log(`覆盖图层已达上限 ${max} 层（可在设置中调整）`);
      break;
    }
    try {
      const size = await fileToSize(file);
      store.covers.push({ name: file.name, file, url: URL.createObjectURL(file), ...size });
      log(`混淆图第 ${store.covers.length} 层 ${file.name} (${size.width}x${size.height})`);
    } catch {
      log(`覆盖图 ${file.name}: 无法解码`);
    }
  }
}

/** 载入解密用密钥文件 */
export async function setKeyFile(files: File[]): Promise<void> {
  const file = files[0];
  if (!file) {
    log('请拖入 .ivkey 密钥文件');
    return;
  }
  try {
    const seed = parseKeyFile(await file.text());
    store.keyFile = { name: file.name, seed };
    log(`密钥文件已载入: ${file.name}`);
  } catch (e) {
    log(`密钥文件 ${file.name}: ${(e as Error).message}`);
  }
}

export async function runEncrypt(): Promise<void> {
  if (store.busy) return;
  if (!store.targets.length) return log('错误: 未选择目标图像');
  if (store.mode === 'overlay' && !store.covers.length) return log('错误: 覆盖模式需要至少一张覆盖图');
  if (store.protection === 'password' && !store.password) return log('错误: 已选择口令保护但未输入口令');

  store.busy = true;
  const params = buildParams();
  // 密钥文件保护：整批共用一枚种子，随该批结果一同保存以便随时下载
  const extSeed = store.protection === 'keyfile' ? randomKeySeed() : undefined;
  const keyFile: KeyFileRef | null = extSeed
    ? { name: 'imgvaguer-key.ivkey', text: await generateKeyFile(extSeed) }
    : null;
  store.batches.push({ items: [], keyFile });
  store.batchIndex = store.batches.length - 1;
  const batch = store.batches[store.batches.length - 1];
  const pack = params.pack === true;
  let okCount = 0;
  log(`开始加密 ${store.targets.length} 项 [${params.mode}/${store.protection}${pack ? '/合并' : ''}]`);
  const batchT0 = performance.now();
  try {
    // 覆盖合成才需要图层位图：先把解码开销做完，避免算在第一张的耗时里
    if (store.mode === 'overlay') {
      const tw = performance.now();
      for (const c of store.covers) await coverRaster(c);
      detail(`[covers] 解码 ${store.covers.length} 层完成 (${(performance.now() - tw).toFixed(0)}ms)`);
    }

    if (pack) {
      okCount = await runEncryptPack(batch, params, extSeed);
    } else {
      for (const t of store.targets) {
        const t0 = performance.now();
        try {
          const coverRasters = await buildCovers(params, t.width, t.height);
          const out = await encryptImage(inputOf(t), params, coverRasters, extSeed, detail);
          okCount++;
          batch.items.push({
            name: suffixed(t.name, '.imgvaguer.png'),
            bytes: out.bytes,
            url: rasterToUrl(out.outRaster),
            ok: true,
          });
          log(`加密 ${t.name} -> ${(out.bytes.length / 1024).toFixed(1)}KB (${(performance.now() - t0).toFixed(0)}ms)`);
        } catch (e) {
          batch.items.push({ name: t.name, bytes: null, url: '', ok: false, error: (e as Error).message });
          log(`失败 ${t.name}: ${(e as Error).message}`);
        }
      }
    }
    if (keyFile && okCount > 0) {
      log('密钥文件已生成：请在结果区下载并分开保管，丢失即无法还原');
    }
    detail(`[batch] 加密完成 成功 ${okCount}/${store.targets.length} 项，总耗时 ${((performance.now() - batchT0) / 1000).toFixed(1)}s`);
  } finally {
    store.busy = false;
  }
}

/** 依当前覆盖层设置，把覆盖图缩放到目标尺寸 */
/** 覆盖图层位图：按需解码并缓存，批量加密时同一层不会反复解码 */
async function coverRaster(c: CoverItem): Promise<Raster> {
  if (!c.raster) c.raster = await fileToRaster(c.file);
  return c.raster;
}

async function buildCovers(params: ImgVaguerParams, width: number, height: number): Promise<Raster[]> {
  if (params.mode !== 'overlay') return [];
  const layers: Raster[] = [];
  for (const c of store.covers) {
    layers.push(degradeRaster(resizeRaster(await coverRaster(c), width, height, params.fit), params.coverQuality ?? 1));
  }
  return layers;
}

/** 多图合并：整批原图 -> 单张输出 */
async function runEncryptPack(
  batch: ResultBatch,
  params: ImgVaguerParams,
  extSeed: Uint8Array | undefined,
): Promise<number> {
  const t0 = performance.now();
  const first = store.targets[0];
  try {
    const sources = store.targets.map(inputOf);
    const covers = await buildCovers(params, first.width, first.height);
    const out = await encryptPack(sources, params, covers, extSeed, detail);
    batch.items.push({
      name: suffixed(first.name, '.imgvaguer.png'),
      bytes: out.bytes,
      url: rasterToUrl(out.outRaster),
      ok: true,
    });
    log(`合并加密 ${store.targets.length} 张 -> ${(out.bytes.length / 1024).toFixed(1)}KB (${(performance.now() - t0).toFixed(0)}ms)`);
    return 1;
  } catch (e) {
    batch.items.push({ name: first.name, bytes: null, url: '', ok: false, error: (e as Error).message });
    log(`合并加密失败: ${(e as Error).message}`);
    return 0;
  }
}

/** 下载当前批次携带的密钥文件 */
export function downloadKeyFile(): void {
  const k = store.batches[store.batchIndex]?.keyFile;
  if (!k) return;
  downloadBytes(new TextEncoder().encode(k.text), k.name, 'application/octet-stream');
  log(`密钥文件已下载: ${k.name}`);
}

export async function runDecrypt(): Promise<void> {
  if (store.busy) return;
  if (!store.targets.length) return log('错误: 未选择待还原图像');

  store.busy = true;
  store.batches.push({ items: [], keyFile: null });
  store.batchIndex = store.batches.length - 1;
  const batch = store.batches[store.batches.length - 1];
  log(`开始解密 ${store.targets.length} 项`);
  const batchT0 = performance.now();
  try {
    for (const t of store.targets) {
      const t0 = performance.now();
      try {
        const bytes = new Uint8Array(await t.file.arrayBuffer());
        if (!readHeader(bytes)) throw new Error('非 ImgVaguer 图像');
        // 像素由引擎从 PNG 内部无损解出；保护方式由尝试凭据自动判定，多图合并自动展开
        const images = await decryptImage(bytes, store.password || undefined, store.keyFile?.seed, detail);
        const multi = images.length > 1;
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          const fallback = suffixed(t.name, multi ? `.${i + 1}.restored` : '.restored');
          if (img.bytes) {
            // 载荷为原始文件字节：直接还原原文件，名称与格式都不改写
            batch.items.push({ name: img.name || fallback, bytes: img.bytes, url: blobUrl(img.bytes), ok: true });
            continue;
          }
          if (!img.raster) continue;
          batch.items.push({
            name: `${img.name || fallback}.png`,
            bytes: encodePng(img.raster),
            url: rasterToUrl(img.raster),
            ok: true,
          });
        }
        log(`还原 ${t.name}${multi ? ` -> ${images.length} 张` : ''} (${(performance.now() - t0).toFixed(0)}ms)`);
      } catch (e) {
        batch.items.push({ name: t.name, bytes: null, url: '', ok: false, error: (e as Error).message });
        log(`失败 ${t.name}: ${(e as Error).message}`);
      }
    }
    const ok = batch.items.filter((i) => i.ok).length;
    detail(`[batch] 解密完成 成功 ${ok}/${store.targets.length} 项，总耗时 ${((performance.now() - batchT0) / 1000).toFixed(1)}s`);
  } finally {
    store.busy = false;
  }
}

/** 按当前操作模式分发执行 */
export async function run(): Promise<void> {
  return store.op === 'encrypt' ? runEncrypt() : runDecrypt();
}

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error('读取失败'));
    fr.readAsDataURL(file);
  });
}

/** 设置默认覆盖图（仅持久化，不影响当前覆盖层；下次启动时生效） */
export async function setDefaultCover(file: File): Promise<void> {
  const maxMB = Math.max(settings.defaultCoverMaxMB, 0.1);
  if (file.size > maxMB * 1024 * 1024) {
    log(`默认覆盖图 ${file.name}: 超过上限 ${maxMB}MB（可在设置中调整）`);
    return;
  }
  try {
    const dataUrl = await fileToDataUrl(file);
    await fileToRaster(file); // 校验可解码
    settings.defaultCover = { name: file.name, dataUrl };
    saveSettings();
    log(`默认混淆图已保存: ${file.name}（下次启动时载入）`);
  } catch {
    log(`默认覆盖图 ${file.name}: 无法解码`);
  }
}

export function clearDefaultCover(): void {
  settings.defaultCover = null;
  saveSettings();
  log('已清除默认覆盖图');
}

/** 启动时载入默认覆盖图 */
export async function applyDefaultCover(): Promise<void> {
  const dc = settings.defaultCover;
  if (!dc || store.covers.length) return;
  try {
    const blob = await (await fetch(dc.dataUrl)).blob();
    const size = await fileToSize(blob);
    store.covers = [{ name: dc.name, file: new File([blob], dc.name), url: dc.dataUrl, ...size }];
    log(`载入默认混淆图 ${dc.name}`);
  } catch {
    log('默认覆盖图载入失败');
  }
}

export function downloadOne(r: ResultItem): void {
  if (r.bytes) downloadBytes(r.bytes, r.name, mimeOf(r.name));
}

/** 在 zip 中为重复文件名追加 -2/-3 后缀，避免互相覆盖 */
function uniqueName(entries: Record<string, Uint8Array>, name: string): string {
  if (!(name in entries)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  while (`${base}-${i}${ext}` in entries) i++;
  return `${base}-${i}${ext}`;
}

/** 下载当前批次的全部结果，并随附该批密钥文件 */
export function downloadAll(): void {
  const batch = store.batches[store.batchIndex];
  if (!batch) return;
  const entries: Record<string, Uint8Array> = {};
  for (const r of batch.items) {
    if (r.ok && r.bytes) entries[uniqueName(entries, r.name)] = r.bytes;
  }
  if (batch.keyFile) {
    entries[uniqueName(entries, batch.keyFile.name)] = new TextEncoder().encode(batch.keyFile.text);
  }
  const names = Object.keys(entries);
  if (!names.length) return;
  if (names.length === 1) {
    return downloadBytes(entries[names[0]], names[0], mimeOf(names[0]));
  }
  const zip = zipSync(entries, { level: 0 });
  downloadBytes(zip, 'imgvaguer-output.zip', 'application/zip');
  log(`打包 ${names.length} 个文件`);
}
