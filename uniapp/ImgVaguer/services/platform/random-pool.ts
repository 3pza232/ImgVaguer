/**
 * 安全随机源池化。
 * - H5 / 部分 App webview：逻辑层自带 crypto（同步），无需干预。
 * - 微信小程序：仅异步 wx.getRandomValues，预取池化。
 * - uni-app App 逻辑层无 Web Crypto：由渲染层（webview）经 renderjs 调 crypto.getRandomValues，
 *   回传后 feedRandom() 注入池中；ensureRandomReady() 会等待注入。
 * 池内不足时显式抛错，绝不退化为弱随机。
 */
import { setRandomProvider } from '@/core/random';

const POOL_MIN = 512;
const NEED = 64;
const REFILL_POLLS = 50;

let pool = new Uint8Array(0);
let inflight: Promise<void> | null = null;

function hasSyncSource(): boolean {
  const c = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto;
  return !!(c && c.getRandomValues);
}

function append(bytes: Uint8Array): void {
  const merged = new Uint8Array(pool.length + bytes.length);
  merged.set(pool);
  merged.set(bytes, pool.length);
  pool = merged;
}

/** 渲染层注入随机字节（App：webview 的 crypto.getRandomValues） */
export function feedRandom(bytes: Uint8Array): void {
  append(bytes);
}

/** 平台异步随机接口（小程序）；其它平台返回 null */
function asyncSource(n: number): Promise<Uint8Array> | null {
  // #ifdef MP-WEIXIN
  return new Promise<Uint8Array>((resolve, reject) => {
    wx.getRandomValues({
      length: n,
      success: (res: { randomValues: ArrayBuffer }) => resolve(new Uint8Array(res.randomValues)),
      fail: (e: { errMsg?: string }) => reject(new Error(e.errMsg ?? '随机数获取失败')),
    });
  });
  // #endif
  // #ifndef MP-WEIXIN
  void n;
  return null;
  // #endif
}

function refill(): Promise<void> {
  if (inflight) return inflight;
  const src = asyncSource(POOL_MIN);
  if (!src) return Promise.resolve();
  inflight = src
    .then((bytes) => append(bytes))
    .then(
      () => {
        inflight = null;
      },
      () => {
        inflight = null;
      },
    );
  return inflight;
}

/** 启动时调用：同步源缺失则安装池化提供者 */
export function installRandom(): void {
  if (hasSyncSource()) return;
  setRandomProvider((n) => {
    if (pool.length < n) throw new Error('安全随机数尚未就绪，请稍后重试');
    const out = pool.slice(0, n);
    pool = pool.slice(n);
    if (pool.length < POOL_MIN) void refill();
    return out;
  });
}

/** 执行加解密前调用：确保池内可用量充足（App 会等待渲染层注入） */
export async function ensureRandomReady(): Promise<void> {
  if (hasSyncSource()) return;
  for (let i = 0; i < REFILL_POLLS; i++) {
    await refill();
    if (pool.length >= NEED) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('当前运行环境缺少安全随机数，无法加密');
}
