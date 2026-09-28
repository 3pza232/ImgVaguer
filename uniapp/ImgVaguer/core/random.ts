/**
 * 安全随机源：优先同步 CSPRNG，其次由平台注入的池化提供者（小程序异步接口预取）。
 * 全平台均无可用源时显式抛错，绝不静默退化为弱随机。
 */

export type RandomProvider = (n: number) => Uint8Array;

let provider: RandomProvider | null = null;

/** 平台层注入（如小程序异步随机接口的池化实现） */
export function setRandomProvider(p: RandomProvider | null): void {
  provider = p;
}

export function randomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c && c.getRandomValues) return new Uint8Array(c.getRandomValues(new Uint8Array(n)));
  if (provider) {
    const b = provider(n);
    if (b.length === n) return b;
  }
  throw new Error('当前环境缺少安全随机源，无法生成密钥材料');
}
