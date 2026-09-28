/**
 * 用户动作：选图 / 批量加解密 / 密钥文件 / 混淆图层 / 导出。
 * 与桌面版业务同构，差异仅在"选文件、读字节、导出"三处改走平台适配层。
 */
import { toBase64 } from '@/core/base64';
import { generateKeyFile, parseKeyFile, randomKeySeed } from '@/core/keyfile';
import { encodePng } from '@/core/png';
import { fitRaster, degradeRaster, thumbRaster } from '@/core/resize';
import type { ImgVaguerParams, Raster } from '@/core/types';
import { detail, log, saveSettings, settings, store, type KeyFileRef, type ResultBatch, type ResultItem } from '@/stores/session';
import { decryptImage, encryptImage, encryptPack, readHeader } from './engine';
// #ifdef APP-PLUS
import { utf8Decode } from '@/core/text';
import { exportBytes, exportTextFile } from '@/services/export';
import { pickAppDocument } from './platform/app-picker';
// #endif
import {
  chooseImagesWithMeta,
  fileNameOf,
  loadImage,
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

/** 单图像素预算：超出后内存与耗时不可控，统一拒绝（约容纳 2000 万像素） */
const MAX_PIXELS = 20_000_000;

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

/** 校验类阻断：既写日志也弹提示，避免"点了没反应"的错觉 */
function warn(msg: string): void {
  log(msg);
  uni.showToast({ title: msg, icon: 'none', duration: 2400 });
}

// #ifdef H5
function asciiFromBytes(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}
// #endif

/** 从相册选择目标图（单批上限 9 张） */
export async function pickTargets(): Promise<void> {
  const remain = 9 - store.targets.length;
  if (remain <= 0) return log('目标图像最多 9 张');
  const files = await chooseImagesWithMeta(remain);
  if (!files.length) return;
  store.progress = '载入图像…';
  try {
    for (const f of files) {
      try {
        const item = await loadImage(f.path, f.name);
        if (item.raster.width * item.raster.height > MAX_PIXELS) {
          log(`跳过 ${item.name}: 超过像素上限（约 2000 万像素）`);
          continue;
        }
        store.targets.push({ name: item.name, path: item.path, raster: item.raster, thumb: item.thumb, preview: item.preview });
        log(`载入 ${item.name} (${item.raster.width}x${item.raster.height})`);
      } catch (e) {
        log(`跳过 ${f.name ?? fileNameOf(f.path)}: ${(e as Error).message}`);
      }
    }
  } finally {
    store.progress = '';
  }
}

/** 追加混淆图层（上限由设置决定） */
export async function pickCovers(): Promise<void> {
  const max = settings.maxCoverLayers;
  if (store.covers.length >= max) return log(`混淆图层已达上限 ${max} 层（可在设置中调整）`);
  const files = await chooseImagesWithMeta(max - store.covers.length);
  if (!files.length) return;
  store.progress = '载入图像…';
  try {
    for (const f of files) {
      if (store.covers.length >= max) {
        log(`混淆图层已达上限 ${max} 层`);
        break;
      }
      try {
        const item = await loadImage(f.path, f.name);
        if (item.raster.width * item.raster.height > MAX_PIXELS) {
          log(`跳过 ${item.name}: 超过像素上限`);
          continue;
        }
        store.covers.push({ name: item.name, path: item.path, raster: item.raster, thumb: item.thumb, preview: item.preview });
        log(`混淆图第 ${store.covers.length} 层 ${item.name}`);
      } catch (e) {
        log(`混淆图 ${f.name ?? fileNameOf(f.path)}: ${(e as Error).message}`);
      }
    }
  } finally {
    store.progress = '';
  }
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

/** 依当前混淆层设置，把混淆图适配到目标尺寸 */
function buildCovers(params: ImgVaguerParams, width: number, height: number): Raster[] {
  if (params.mode !== 'overlay') return [];
  return store.covers.map((c) => degradeRaster(fitRaster(c.raster, width, height, params.fit), params.coverQuality ?? 1));
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

/** 结果预览图边长：完整像素留在 bytes 中供导出；预览覆盖 1080p 屏以免放大发糊 */
const PREVIEW_MAX_EDGE = 1280;

async function previewOf(raster: Raster): Promise<string> {
  return rasterToSrc(thumbRaster(raster, PREVIEW_MAX_EDGE));
}

export async function runEncrypt(): Promise<void> {
  if (store.busy) return;
  if (!store.targets.length) return warn('未选择目标图像');
  if (store.mode === 'overlay' && !store.covers.length) return warn('覆盖模式需要至少一张混淆图');
  if (store.protection === 'password' && !store.password) return warn('已选择口令保护但未输入口令');

  store.busy = true;
  store.progress = '';
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

    if (pack) {
      store.progress = '合并加密中…';
      try {
        const first = store.targets[0];
        const images = store.targets.map((t) => ({ name: t.name, raster: t.raster }));
        const out = await encryptPack(images, params, buildCovers(params, first.raster.width, first.raster.height), extSeed, detail);
        okCount = 1;
        batch.items.push({
          name: suffixed(first.name, '.imgvaguer.png'),
          bytes: out.bytes,
          preview: await previewOf(out.outRaster),
          ok: true,
        });
        log(`合并加密 ${store.targets.length} 张 -> ${(out.bytes.length / 1024).toFixed(1)}KB`);
      } catch (e) {
        batch.items.push({ name: store.targets[0].name, bytes: null, preview: '', ok: false, error: (e as Error).message });
        log(`合并加密失败: ${(e as Error).message}`);
      }
    } else {
      for (const t of store.targets) {
        const t0 = Date.now();
        try {
          const out = await encryptImage(t.raster, params, buildCovers(params, t.raster.width, t.raster.height), extSeed, detail);
          okCount++;
          batch.items.push({
            name: suffixed(t.name, '.imgvaguer.png'),
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
  } finally {
    store.busy = false;
    store.progress = '';
  }
}

export async function runDecrypt(): Promise<void> {
  if (store.busy) return;
  if (!store.targets.length) return warn('未选择待还原图像');

  store.busy = true;
  store.progress = '';
  try {
    const batch = newBatch(null);
    log(`开始解密 ${store.targets.length} 项`);
    for (const t of store.targets) {
      const t0 = Date.now();
      try {
        store.progress = `解密 ${t.name}…`;
        const bytes = await readFileBytes(t.path);
        if (!readHeader(bytes)) throw new Error('非 ImgVaguer 图像（可能被二次压缩，请用原始输出文件）');
        const images = await decryptImage(bytes, store.password || undefined, store.keyFile?.seed, detail);
        const multi = images.length > 1;
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          const name = img.name ? suffixed(img.name, '.restored.png') : suffixed(t.name, multi ? `.${i + 1}.restored.png` : '.restored.png');
          batch.items.push({ name, bytes: encodePng(img.raster), preview: await previewOf(img.raster), ok: true });
        }
        log(`还原 ${t.name}${multi ? ` -> ${images.length} 张` : ''} (${Date.now() - t0}ms)`);
      } catch (e) {
        batch.items.push({ name: t.name, bytes: null, preview: '', ok: false, error: (e as Error).message });
        log(`失败 ${t.name}: ${(e as Error).message}`);
      }
    }
  } finally {
    store.busy = false;
    store.progress = '';
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
  store.busy = true;
  store.progress = '导出中…';
  try {
    // #ifdef APP-PLUS
    reportExport(await exportBytes(item.bytes, item.name), item.name);
    // #endif
    // #ifndef APP-PLUS
    const r = await saveImage(item.bytes, item.name);
    log(r.message);
    uni.showToast({ title: r.message, icon: 'none', duration: 2200 });
    // #endif
  } finally {
    store.busy = false;
    store.progress = '';
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
  store.busy = true;
  let done = 0;
  try {
    for (let i = 0; i < okItems.length; i++) {
      const item = okItems[i];
      store.progress = `导出中 ${i + 1}/${okItems.length}`;
      // #ifdef APP-PLUS
      const r = await exportBytes(item.bytes as Uint8Array, item.name);
      if (r.ok) done++;
      log(r.ok ? `导出 ${item.name} -> ${r.path}` : `导出失败 ${item.name}: ${r.message}`);
      // #endif
      // #ifndef APP-PLUS
      const r = await saveImage(item.bytes as Uint8Array, item.name);
      if (r.ok) done++;
      log(r.message);
      // #endif
    }
    uni.showToast({
      title: done === okItems.length ? `已导出 ${done} 张到 ${label}` : `导出 ${done}/${okItems.length}，详见日志`,
      icon: 'none',
      duration: 2600,
    });
  } finally {
    store.busy = false;
    store.progress = '';
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
    const item = await loadImage(path, name);
    const png = encodePng(item.raster);
    if (png.length > limit) {
      log(`默认混淆图 ${(png.length / 1024 / 1024).toFixed(1)}MB 超过上限 ${maxMB}MB（可在设置中调整）`);
      uni.showToast({ title: `超过 ${maxMB}MB 上限，未保存`, icon: 'none', duration: 2400 });
      return;
    }
    settings.defaultCover = { name: item.name, dataUrl: `data:image/png;base64,${toBase64(png)}` };
    saveSettings();
    log(`默认混淆图已保存: ${item.name}（${(png.length / 1024).toFixed(0)}KB，下次启动时载入）`);
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
    store.covers = [{
      name: dc.name,
      path: '',
      raster,
      thumb: await rasterToSrc(thumbRaster(raster, 256)),
      preview: await rasterToSrc(thumbRaster(raster, 1280)),
    }];
    log(`载入默认混淆图 ${dc.name}`);
  } catch {
    log('默认混淆图载入失败');
  }
}
