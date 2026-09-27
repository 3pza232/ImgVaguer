/**
 * 密钥文件（.ivkey）：32 字节随机种子的文本封装。
 * 文件即主密钥本身，与图像分离保管；丢失或泄露等同口令丢失/泄露。
 */

export const KEY_MAGIC = 'IMGVAGUER-KEY v1';
export const KEY_SEED_LEN = 32;

export function generateKeyFile(seed: Uint8Array): string {
  if (seed.length !== KEY_SEED_LEN) throw new Error('种子长度非法');
  let bin = '';
  for (const b of seed) bin += String.fromCharCode(b);
  return `${KEY_MAGIC}\n${btoa(bin)}\n`;
}

export function parseKeyFile(text: string): Uint8Array {
  const lines = text.trim().split(/\r?\n/);
  if (lines[0]?.trim() !== KEY_MAGIC) throw new Error('非法的密钥文件（缺少文件头）');
  const b64 = lines.slice(1).join('').replace(/\s+/g, '');
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new Error('密钥文件内容损坏');
  }
  const seed = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (seed.length !== KEY_SEED_LEN) throw new Error('密钥长度非法');
  return seed;
}

export function randomKeySeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_SEED_LEN));
}
