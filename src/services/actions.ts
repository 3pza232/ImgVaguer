/** 用户动作：批量加密 / 批量解密 / 密钥文件 / 覆盖层 / 下载 */
import { generateKeyFile, parseKeyFile, randomKeySeed } from '@/core/keyfile';
import { encodePng } from '@/core/png';
import type { ImgVaguerParams, Raster } from '@/core/types';
import { detail, log, saveSettings, settings, store, type KeyFileRef, type ResultItem } from '@/stores/session';
import { zipSync } from 'fflate';
import { decryptImage, encryptImage, readHeader } from './engine';
import { degradeRaster, downloadBytes, fileToRaster, rasterToUrl, resizeRaster } from './image-io';

function buildParams(): ImgVaguerParams {
  const base = {
    protection: store.protection,
    password: store.password,
    iterations: store.iterations,
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

export async function addTargets(files: File[]): Promise<void> {
  for (const file of files) {
    try {
      const raster = await fileToRaster(file);
      store.targets.push({ name: file.name, file, raster, url: URL.createObjectURL(file) });
      log(`载入 ${file.name} (${raster.width}x${raster.height})`);
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
      const raster = await fileToRaster(file);
      store.covers.push({ name: file.name, file, raster, url: URL.createObjectURL(file) });
      log(`混淆图第 ${store.covers.length} 层 ${file.name} (${raster.width}x${raster.height})`);
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
    ? { name: 'imgvaguer-key.ivkey', text: generateKeyFile(extSeed) }
    : null;
  store.batches.push({ items: [], keyFile });
  store.batchIndex = store.batches.length - 1;
  const batch = store.batches[store.batches.length - 1];
  let okCount = 0;
  log(`开始加密 ${store.targets.length} 项 [${params.mode}/${store.protection}]`);
  try {
    for (const t of store.targets) {
      const t0 = performance.now();
      try {
        let coverRasters: Raster[] = [];
        if (params.mode === 'overlay') {
          coverRasters = store.covers.map((c) =>
            degradeRaster(
              resizeRaster(c.raster, t.raster.width, t.raster.height, params.fit),
              params.coverQuality ?? 1,
            ),
          );
        }
        const out = await encryptImage(t.raster, params, coverRasters, extSeed, detail);
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
    if (keyFile && okCount > 0) {
      log('密钥文件已生成：请在结果区下载并分开保管，丢失即无法还原');
    }
  } finally {
    store.busy = false;
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
  try {
    for (const t of store.targets) {
      const t0 = performance.now();
      try {
        const bytes = new Uint8Array(await t.file.arrayBuffer());
        if (!readHeader(bytes)) throw new Error('非 ImgVaguer 图像');
        // 像素由引擎从 PNG 内部无损解出；保护方式由尝试凭据自动判定
        const restored = await decryptImage(bytes, store.password || undefined, store.keyFile?.seed, detail);
        const out = encodePng(restored);
        batch.items.push({
          name: suffixed(t.name, '.restored.png'),
          bytes: out,
          url: rasterToUrl(restored),
          ok: true,
        });
        log(`还原 ${t.name} (${(performance.now() - t0).toFixed(0)}ms)`);
      } catch (e) {
        batch.items.push({ name: t.name, bytes: null, url: '', ok: false, error: (e as Error).message });
        log(`失败 ${t.name}: ${(e as Error).message}`);
      }
    }
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
    const raster = await fileToRaster(blob);
    store.covers = [{ name: dc.name, file: new File([blob], dc.name), raster, url: dc.dataUrl }];
    log(`载入默认混淆图 ${dc.name}`);
  } catch {
    log('默认覆盖图载入失败');
  }
}

export function downloadOne(r: ResultItem): void {
  if (r.bytes) downloadBytes(r.bytes, r.name);
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
    const mime = names[0].endsWith('.ivkey') ? 'application/octet-stream' : 'image/png';
    return downloadBytes(entries[names[0]], names[0], mime);
  }
  const zip = zipSync(entries, { level: 0 });
  downloadBytes(zip, 'imgvaguer-output.zip', 'application/zip');
  log(`打包 ${names.length} 个文件`);
}
