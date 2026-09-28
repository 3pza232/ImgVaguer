/**
 * 密钥文件（.ivkey）：32 字节随机种子的文本封装。
 * 文件即主密钥本身，与图像分离保管；丢失或泄露等同口令丢失/泄露。
 *
 * 文本格式（多行，含创建时间与密钥指纹，便于识别与核对）：
 *   IMGVAGUER KEYFILE v1
 *   created: <ISO 时间>
 *   fingerprint: <SHA-256 前 8 字节 hex>
 *   --
 *   <种子 Base64，按行折行>
 * Base64 为纯 TS 实现，不依赖 btoa/atob（小程序 runtime 不提供）。
 */
import { fromBase64, toBase64 } from './base64';
import { sha256 } from './hash';
import { randomBytes } from './random';

export const KEY_MAGIC = 'IMGVAGUER KEYFILE';
export const KEY_SEED_LEN = 32;
const WRAP = 48;

function wrap(text: string, width: number): string {
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width));
  return lines.join('\n');
}

async function fingerprint(seed: Uint8Array): Promise<string> {
  const digest = await sha256(seed);
  return [...digest.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function generateKeyFile(seed: Uint8Array): Promise<string> {
  if (seed.length !== KEY_SEED_LEN) throw new Error('种子长度非法');
  const lines = [
    `${KEY_MAGIC} v1`,
    `created: ${new Date().toISOString()}`,
    `fingerprint: ${await fingerprint(seed)}`,
    '--',
    wrap(toBase64(seed), WRAP),
    '',
  ];
  return lines.join('\n');
}

export function parseKeyFile(text: string): Uint8Array {
  const lines = text.split(/\r?\n/);
  const first = lines[0]?.trim() ?? '';
  if (!first.startsWith(KEY_MAGIC)) throw new Error('非法的密钥文件（缺少文件头）');
  const sep = lines.findIndex((l) => l.trim() === '--');
  const seed = fromBase64(lines.slice(sep >= 0 ? sep + 1 : 1).join(''));
  if (seed.length !== KEY_SEED_LEN) throw new Error('密钥长度非法');
  return seed;
}

export function randomKeySeed(): Uint8Array {
  return randomBytes(KEY_SEED_LEN);
}
