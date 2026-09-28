/**
 * 用户动作：选图 / 批量加解密 / 密钥文件 / 混淆图层 / 导出。
 * 与桌面版业务同构，差异仅在"选文件、读字节、导出"三处改走平台适配层。
 */
import { toBase64 } from '@/core/base64';
import { generateKeyFile, parseKeyFile, randomKeySeed } from '@/core/keyfile';
import { encodePng } from '@/core/png';
import { fitRaster, degradeRaster, thumbRaster } from '@/core/resize';
import type { ImgVaguerParams, Raster } from '@/core/types';
import { detail, log, saveSettings, settings, store, type CoverItem, type KeyFileRef, type ResultBatch, type ResultItem, type TargetItem } from '@/stores/session';
import { decryptImage, encryptImage, encryptPack, readHeader, type EncryptInput } from './engine';
// #ifdef APP-PLUS
import { utf8Decode } from '@/core/text';
import { exportBytes, exportTextFile } from '@/services/export';
import { pickAppDocument } from './platform/app-picker';
// #endif
import {
  bytesToSrc,
  chooseImagesWithMeta,
  decodeRaster,
  fileNameOf,
  PREVIEW_EDGE,
  probeImage,
  rasterFromDataUrl,
  rasterToSrc,
  readFileBytes,
} from './platform/image-io';
import { ensureRandomReady } from './platform/random-pool';
import { copyText } from './platform/save';
// #ifndef APP-PLUS
import { exportText, saveImage } from './platform/save';
// #endif
// #ifndef H5
import { readClipboard } from './platform/save';
// #endif

/** 相册选择器单次可选张数上限（各端一致） */
const PICK_MAX = 9;

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

/**
 * 加密结果文件名：在标记前插入时间戳。
 * 写入端会覆盖同名文件，而系统相册的缩略图按路径缓存——
 * 同名覆盖会让相册与选图器继续显示上一张的缩略图，故每次输出都用新路径。
 */
function cipherName(name: string): string {
  return suffixed(name, `.${Date.now().toString(36)}.imgvaguer.png`);
}

/** 校验类阻断：既写日志也弹提示，避免"点了没反应"的错觉 */
function warn(msg: string): void {
  log(msg);
  uni.showToast({ title: msg, icon: 'none', duration: 2400 });
}

/**
 * 让出主线程一拍。逐像素变换与熵编码是整段同步计算，其间界面无法重绘；
 * 在任务开始与每张图之间让出一拍，至少保证"处理中"状态与进度先渲染出来。
 */
function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 按扩展名推断 MIME：还原结果的格式跟随原文件，不能再假定为 PNG */
function mimeOf(name: string): string {
  const ext = (name.match(/\.(\w+)$/)?.[1] ?? '').toLowerCase();
  const known: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
    ivkey: 'application/octet-stream',
  };
  return known[ext] ?? 'application/octet-stream';
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
    bytes: () => readFileBytes(t.path),
    raster: () => decodeRaster(t.path),
  };
}

// #ifdef H5
function asciiFromBytes(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}
// #endif

/** 从相册选择目标图（累计上限由设置决定，选择器单次至多 9 张） */
export async function pickTargets(): Promise<void> {
  const remain = settings.maxTargets - store.targets.length;
  if (remain <= 0) return log(`目标图像已达上限 ${settings.maxTargets} 张（可在设置中调整）`);
  const files = await chooseImagesWithMeta(Math.min(PICK_MAX, remain));
  if (!files.length) return;
  for (const f of files) {
    if (store.targets.length >= settings.maxTargets) {
      log(`目标图像已达上限 ${settings.maxTargets} 张`);
      break;
    }
    try {
      const item = await probeImage(f.path, f.name);
      if (item.width * item.height > settings.maxPixels) {
        log(`跳过 ${item.name}: ${item.width}x${item.height} 超过像素上限 ${(settings.maxPixels / 10000).toFixed(0)} 万（可在设置中调整）`);
        continue;
      }
      store.targets.push(item);
      log(`载入 ${item.name} (${item.width}x${item.height})`);
    } catch (e) {
      log(`跳过 ${f.name ?? fileNameOf(f.path)}: ${(e as Error).message}`);
    }
  }
}

/** 追加混淆图层（上限由设置决定） */
export async function pickCovers(): Promise<void> {
  const max = settings.maxCoverLayers;
  if (store.covers.length >= max) return log(`混淆图层已达上限 ${max} 层（可在设置中调整）`);
  const files = await chooseImagesWithMeta(max - store.covers.length);
  if (!files.length) return;
  for (const f of files) {
    if (store.covers.length >= max) {
      log(`混淆图层已达上限 ${max} 层`);
      break;
    }
    try {
      const probed = await probeImage(f.path, f.name);
      if (probed.width * probed.height > settings.maxPixels) {
        log(`跳过 ${probed.name}: 超过像素上限 ${(settings.maxPixels / 10000).toFixed(0)} 万（可在设置中调整）`);
        continue;
      }
      store.covers.push({ ...probed });
      log(`混淆图第 ${store.covers.length} 层 ${probed.name} (${probed.width}x${probed.height})`);
    } catch (e) {
      log(`混淆图 ${f.name ?? fileNameOf(f.path)}: ${(e as Error).message}`);
    }
  }
  // 后台预热：非 PNG 图层解码较慢，放在这里做，等用户设好参数再点加密时就已经就绪
  // 失败不在此打扰用户，解码任务会被丢弃，真正加密时会重试并如实报错
  void warmCovers().catch(() => undefined);
}

// ── 密钥（.ivkey）──

/** 无文件名来源（剪贴板/粘贴）的显示名：优先取文件内指纹，便于与图像核对 */
function keyDisplayName(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().toLowerCase().startsWith('fingerprint:'));
  const fp = line?.split(':')[1]?.trim();
  return fp ? `密钥 · 指纹 ${fp.slice(0, 8)}` : '密钥（粘贴载入）';
}

/** 载入密钥文本；失败必给提示，避免"点了没反应"的错觉 */
export function setKeyFromText(text: string, name?: string): void {
  try {
    store.keyFile = { name: name || keyDisplayName(text), seed: parseKeyFile(text) };
    log(`密钥已载入: ${store.keyFile.name}`);
    uni.showToast({ title: '密钥已载入', icon: 'none', duration: 1800 });
  } catch (e) {
    const msg = `密钥载入失败：${(e as Error).message}`;
    log(msg);
    uni.showToast({ title: msg, icon: 'none', duration: 2800 });
  }
}

/**
 * 经系统文件管理器选择密钥文件（App）。
 * H5 退化为文件选择；小程序无文件选择能力，提示走剪贴板。
 */
export async function pickKeyFromSystem(): Promise<void> {
  // #ifdef APP-PLUS
  const picked = await pickAppDocument('*/*', settings.exportTree?.uri);
  if (!picked.ok) {
    log(`未载入密钥：${picked.message}`);
    uni.showToast({ title: picked.message, icon: 'none', duration: 2400 });
    return;
  }
  loadKeyFromPath(picked.path, picked.name);
  return;
  // #endif
  // #ifdef H5
  await pickKeyFile();
  // #endif
  // #ifdef MP-WEIXIN
  warn('小程序端请用「剪贴板」载入密钥');
  // #endif
}

/**
 * 载入密钥：
 * H5 走文件选择（uni.chooseFile 为 H5 专属）；小程序无文件选择能力，改由剪贴板载入。
 */
export async function pickKeyFile(): Promise<void> {
  // #ifdef H5
  const picked = await new Promise<string | null>((resolve) => {
    uni.chooseFile({
      count: 1,
      extension: ['.ivkey', '.txt'],
      success: (res: { tempFilePaths?: string[] }) => resolve(res.tempFilePaths?.[0] ?? null),
      fail: () => resolve(null),
    });
  });
  if (!picked) return;
  try {
    setKeyFromText(asciiFromBytes(await readFileBytes(picked)), fileNameOf(picked));
  } catch (e) {
    log(`密钥文件读取失败: ${(e as Error).message}`);
  }
  // #endif
  // #ifndef H5
  const text = await readClipboard();
  if (!text) {
    log('剪贴板为空，请先复制 .ivkey 内容');
    uni.showToast({ title: '剪贴板为空', icon: 'none', duration: 2400 });
    return;
  }
  setKeyFromText(text);
  // #endif
}

// #ifdef APP-PLUS
/** 由系统选择器转存的路径载入密钥（字节 → UTF-8 文本） */
async function loadKeyFromPath(path: string, name: string): Promise<void> {
  try {
    setKeyFromText(utf8Decode(await readFileBytes(path)), name);
  } catch (e) {
    const msg = `密钥文件读取失败：${(e as Error).message}`;
    log(msg);
    uni.showToast({ title: msg, icon: 'none', duration: 2800 });
  }
}
// #endif

/**
 * 预热混淆图层：把首次合成前的解码开销挪到批处理开始前，并让日志说清楚在等什么。
 * 逐层解码在 buildCovers 里已做缓存，故此处只是把"慢起步"显式化。
 */
async function warmCovers(): Promise<void> {
  for (const c of store.covers) {
    const t0 = Date.now();
    await coverRaster(c);
    // 非 PNG 图层只能经平台画布解码，而画布受屏幕尺寸限制必须分块，耗时直接取决于图层尺寸
    detail(`[covers] ${c.width}x${c.height} 解码完成 (${Date.now() - t0}ms)`);
  }
}

/**
 * 解码中的图层任务，按来源路径去重。
 * 载入后预热与加密可能并发触发同一层的解码，去重后两者共用一次结果
 * （非 PNG 图层一次解码可长达数秒，重复一次代价太大）。
 */
const coverJobs = new Map<string, Promise<Raster>>();

/** 混淆图层位图：按需解码并缓存，批量加密时同一层不会反复解码 */
async function coverRaster(c: CoverItem): Promise<Raster> {
  if (c.raster) return c.raster;
  let job = coverJobs.get(c.path);
  if (!job) {
    job = decodeCover(c);
    coverJobs.set(c.path, job);
  }
  try {
    c.raster = await job;
    return c.raster;
  } catch (e) {
    coverJobs.delete(c.path);
    throw e;
  }
}

/** 解析图层位图：默认混淆图来自设置中的 data URL，其余走平台解码 */
function decodeCover(c: CoverItem): Promise<Raster> {
  return c.path.startsWith('data:') ? rasterFromDataUrl(c.path) : decodeRaster(c.path);
}

/** 依当前混淆层设置，把混淆图适配到目标尺寸 */
async function buildCovers(params: ImgVaguerParams, width: number, height: number): Promise<Raster[]> {
  if (params.mode !== 'overlay') return [];
  const layers: Raster[] = [];
  for (const c of store.covers) {
    layers.push(degradeRaster(fitRaster(await coverRaster(c), width, height, params.fit), params.coverQuality ?? 1));
  }
  return layers;
}

/**
 * 新建结果批次并返回「响应式代理」。
 * 注意：必须经 store 取回代理后再 push，直接写原始对象不会触发视图更新。
 */
function newBatch(keyFile: KeyFileRef | null): ResultBatch {
  store.batches.push({ items: [], keyFile });
  store.batchIndex = store.batches.length - 1;
  return store.batches[store.batchIndex];
}

/** 结果预览源：完整像素留在 bytes 中供导出，预览只取缩略尺寸以免放大发糊 */
async function previewOf(raster: Raster): Promise<string> {
  return rasterToSrc(thumbRaster(raster, PREVIEW_EDGE));
}

export async function runEncrypt(): Promise<void> {
  if (store.busy) return;
  if (!store.targets.length) return warn('未选择目标图像');
  if (store.mode === 'overlay' && !store.covers.length) return warn('覆盖模式需要至少一张混淆图');
  if (store.protection === 'password' && !store.password) return warn('已选择口令保护但未输入口令');

  store.busy = 'encrypt';
  try {
    await ensureRandomReady();
    const params = buildParams();
    const extSeed = store.protection === 'keyfile' ? randomKeySeed() : undefined;
    const keyFile: KeyFileRef | null = extSeed
      ? { name: 'imgvaguer-key.ivkey', text: await generateKeyFile(extSeed) }
      : null;
    const batch = newBatch(keyFile);
    const pack = params.pack === true;
    log(`开始加密 ${store.targets.length} 项 [${params.mode}/${store.protection}${pack ? '/合并' : ''}]`);
    let okCount = 0;
    const batchT0 = Date.now();

    // 混淆图层只在覆盖合成中参与，故按需预热，避免无谓解码
    if (params.mode === 'overlay') await warmCovers();

    if (pack) {
      try {
        const t0 = Date.now();
        const first = store.targets[0];
        const sources = store.targets.map(inputOf);
        const out = await encryptPack(sources, params, await buildCovers(params, first.width, first.height), extSeed, detail);
        okCount = 1;
        batch.items.push({
          name: cipherName(first.name),
          bytes: out.bytes,
          preview: await previewOf(out.outRaster),
          ok: true,
        });
        log(`合并加密 ${store.targets.length} 张 -> ${(out.bytes.length / 1024).toFixed(1)}KB (${Date.now() - t0}ms)`);
      } catch (e) {
        batch.items.push({ name: store.targets[0].name, bytes: null, preview: '', ok: false, error: (e as Error).message });
        log(`合并加密失败: ${(e as Error).message}`);
      }
    } else {
      for (const t of store.targets) {
        await yieldToUI();
        const t0 = Date.now();
        try {
          const out = await encryptImage(inputOf(t), params, await buildCovers(params, t.width, t.height), extSeed, detail);
          okCount++;
          batch.items.push({
            name: cipherName(t.name),
            bytes: out.bytes,
            preview: await previewOf(out.outRaster),
            ok: true,
          });
          log(`加密 ${t.name} -> ${(out.bytes.length / 1024).toFixed(1)}KB (${Date.now() - t0}ms)`);
        } catch (e) {
          batch.items.push({ name: t.name, bytes: null, preview: '', ok: false, error: (e as Error).message });
          log(`失败 ${t.name}: ${(e as Error).message}`);
        }
      }
    }
    if (keyFile && okCount > 0) {
      log('密钥已生成：请在结果区导出并分开保管，丢失即无法还原');
    }
    detail(`[batch] 加密完成 成功 ${okCount}/${store.targets.length} 项，总耗时 ${((Date.now() - batchT0) / 1000).toFixed(1)}s`);
  } finally {
    store.busy = null;
  }
}

export async function runDecrypt(): Promise<void> {
  if (store.busy) return;
  if (!store.targets.length) return warn('未选择待还原图像');

  store.busy = 'decrypt';
  try {
    const batch = newBatch(null);
    log(`开始解密 ${store.targets.length} 项`);
    const batchT0 = Date.now();
    for (const t of store.targets) {
      const t0 = Date.now();
      try {
        await yieldToUI();
        const bytes = await readFileBytes(t.path);
        if (!readHeader(bytes)) throw new Error('非 ImgVaguer 图像（可能被二次压缩，请用原始输出文件）');
        const images = await decryptImage(bytes, store.password || undefined, store.keyFile?.seed, detail);
        const multi = images.length > 1;
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          const fallback = suffixed(t.name, multi ? `.${i + 1}.restored` : '.restored');
          if (img.bytes) {
            // 载荷为原始文件字节：直接还原原文件，名称与格式都不改写
            batch.items.push({ name: img.name || fallback, bytes: img.bytes, preview: await bytesToSrc(img.bytes, img.name), ok: true });
            continue;
          }
          if (!img.raster) continue;
          batch.items.push({
            name: `${img.name || fallback}.png`,
            bytes: encodePng(img.raster),
            preview: await previewOf(img.raster),
            ok: true,
          });
        }
        log(`还原 ${t.name}${multi ? ` -> ${images.length} 张` : ''} (${Date.now() - t0}ms)`);
      } catch (e) {
        batch.items.push({ name: t.name, bytes: null, preview: '', ok: false, error: (e as Error).message });
        log(`失败 ${t.name}: ${(e as Error).message}`);
      }
    }
    const ok = batch.items.filter((i) => i.ok).length;
    detail(`[batch] 解密完成 成功 ${ok}/${store.targets.length} 项，总耗时 ${((Date.now() - batchT0) / 1000).toFixed(1)}s`);
  } finally {
    store.busy = null;
  }
}

/** 按当前操作模式分发执行 */
export async function run(): Promise<void> {
  return store.op === 'encrypt' ? runEncrypt() : runDecrypt();
}

// ── 导出 ──

export async function saveResult(item: ResultItem): Promise<void> {
  if (!item.bytes || store.busy) return;
  // 单张导出同样在底部按钮显示进度
  store.busy = 'export';
  const t0 = Date.now();
  try {
    // #ifdef APP-PLUS
    reportExport(await exportBytes(item.bytes, item.name, mimeOf(item.name)), item.name);
    // #endif
    // #ifndef APP-PLUS
    const r = await saveImage(item.bytes, item.name, mimeOf(item.name));
    log(r.message);
    uni.showToast({ title: r.message, icon: 'none', duration: 2200 });
    // #endif
  } finally {
    store.busy = null;
    detail(`[export] ${item.name} 完成 (${Date.now() - t0}ms)`);
  }
}

// #ifdef APP-PLUS
/** 统一导出反馈：成功附完整路径（提示保持简短，路径记入日志） */
function reportExport(r: { ok: boolean; path: string; message: string; needDir?: boolean }, name: string): void {
  if (!r.ok) {
    log(`导出失败 ${name}: ${r.message}`);
    uni.showToast({ title: `导出失败：${r.message}`, icon: 'none', duration: 3200 });
    return;
  }
  log(`导出 ${name} -> ${r.path}${r.message}`);
  uni.showToast({ title: `已导出 ${name}`, icon: 'none', duration: 2200 });
}
// #endif

export async function saveAll(): Promise<void> {
  const batch = store.batches[store.batchIndex];
  if (!batch) return;
  const okItems = batch.items.filter((i) => i.ok && i.bytes);
  if (!okItems.length) return warn('本批没有可导出的结果');
  // #ifdef APP-PLUS
  const label = settings.exportTree?.name ?? '所选文件夹';
  // #endif
  // #ifndef APP-PLUS
  const label = '本地目录';
  // #endif
  store.busy = 'export';
  const batchT0 = Date.now();
  let done = 0;
  try {
    for (let i = 0; i < okItems.length; i++) {
      const item = okItems[i];
      const t0 = Date.now();
      // #ifdef APP-PLUS
      const r = await exportBytes(item.bytes as Uint8Array, item.name, mimeOf(item.name));
      if (r.ok) done++;
      log(r.ok ? `导出 ${item.name} -> ${r.path} (${Date.now() - t0}ms)` : `导出失败 ${item.name}: ${r.message}`);
      // #endif
      // #ifndef APP-PLUS
      const r = await saveImage(item.bytes as Uint8Array, item.name, mimeOf(item.name));
      if (r.ok) done++;
      log(`${r.message} (${Date.now() - t0}ms)`);
      // #endif
    }
    detail(`[export] 完成 ${done}/${okItems.length} 项，总耗时 ${((Date.now() - batchT0) / 1000).toFixed(1)}s`);
    uni.showToast({
      title: done === okItems.length ? `已导出 ${done} 张到 ${label}` : `导出 ${done}/${okItems.length}，详见日志`,
      icon: 'none',
      duration: 2600,
    });
  } finally {
    store.busy = null;
  }
}

/** 导出当前批次的密钥文件：App 写入「存储位置/ImgVaguer」，其余平台走平台下载/剪贴板 */
export async function exportKey(nameOverride?: string): Promise<void> {
  const k = store.batches[store.batchIndex]?.keyFile;
  if (!k) return;
  // #ifdef APP-PLUS
  // 文件名严格采用界面所填内容（不追加后缀）
  const r = await exportTextFile(k.text, nameOverride || k.name);
  if (r.ok) {
    log(`密钥已保存 -> ${r.path}${r.message}`);
    uni.showToast({ title: '密钥已保存', icon: 'none', duration: 2400 });
  } else {
    log(`密钥保存失败: ${r.message}`);
    uni.showToast({ title: `密钥保存失败：${r.message}`, icon: 'none', duration: 3200 });
  }
  return;
  // #endif
  // #ifndef APP-PLUS
  const r = exportText(k.text, nameOverride || k.name);
  log(r.message);
  uni.showToast({ title: r.message, icon: 'none', duration: 2400 });
  // #endif
}

export function copyKey(): void {
  const k = store.batches[store.batchIndex]?.keyFile;
  if (!k) return;
  copyText(k.text);
}

// ── 设置：默认混淆图 ──

export function clearDefaultCover(): void {
  settings.defaultCover = null;
  saveSettings();
  log('已清除默认混淆图');
}

/**
 * 设为默认混淆图：仅持久化（下次启动生效），不影响当前图层。
 * 统一重编码为 PNG——各端画布解码能力不一，PNG 才能保证下次启动无损还原。
 */
export async function setDefaultCoverFromPath(path: string, name?: string): Promise<void> {
  const maxMB = Math.max(settings.defaultCoverMaxMB, 0.1);
  const limit = maxMB * 1024 * 1024;
  try {
    const probed = await probeImage(path, name);
    const png = encodePng(await decodeRaster(path));
    if (png.length > limit) {
      log(`默认混淆图 ${(png.length / 1024 / 1024).toFixed(1)}MB 超过上限 ${maxMB}MB（可在设置中调整）`);
      uni.showToast({ title: `超过 ${maxMB}MB 上限，未保存`, icon: 'none', duration: 2400 });
      return;
    }
    settings.defaultCover = { name: probed.name, dataUrl: `data:image/png;base64,${toBase64(png)}` };
    saveSettings();
    log(`默认混淆图已保存: ${probed.name}（${(png.length / 1024).toFixed(0)}KB，下次启动时载入）`);
    uni.showToast({ title: '已保存为默认混淆图', icon: 'none', duration: 2200 });
  } catch {
    log('默认混淆图设置失败：无法解码');
  }
}

/** 选择默认混淆图（仅持久化，下次启动生效） */
export async function pickDefaultCover(): Promise<void> {
  const [f] = await chooseImagesWithMeta(1);
  if (f) await setDefaultCoverFromPath(f.path, f.name);
}

/** 启动时载入默认混淆图 */
export async function applyDefaultCover(): Promise<void> {
  const dc = settings.defaultCover;
  if (!dc || store.covers.length) return;
  try {
    const raster = await rasterFromDataUrl(dc.dataUrl);
    // 默认混淆图本身已是可直接显示的 data URL，path 兼作预览源与解码来源
    store.covers = [{ name: dc.name, path: dc.dataUrl, width: raster.width, height: raster.height, raster }];
    log(`载入默认混淆图 ${dc.name}`);
  } catch {
    log('默认混淆图载入失败');
  }
}
