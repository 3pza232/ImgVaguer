/**
 * 密钥派生：PBKDF2-SHA256 → 主密钥 → 标签化 SHA-256 展开子密钥。
 * 子密钥按用途隔离（置换 / 异或流 / 噪声 / MAC / 载荷 / 元数据），避免跨域复用。
 * 原语实现见 hash.ts（WebCrypto 优先，App/小程序走纯 TS 兜底）。
 */
import { hmacSha256, pbkdf2, sha256 } from './hash';
import { utf8Encode } from './text';

/** 由任意字节凭据（口令 / 密钥文件 / 内嵌种子）派生 256 位主密钥 */
export function deriveMasterKey(secret: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  return pbkdf2(secret, salt, iterations);
}

/** 口令字符串 → 字节凭据 */
export function passwordBytes(password: string): Uint8Array {
  return utf8Encode(password);
}

export interface SubKeys {
  perm: Uint8Array;
  xor: Uint8Array;
  noise: Uint8Array;
  mac: Uint8Array;
  overlay: Uint8Array;
  meta: Uint8Array;
}

export async function deriveSubKeys(master: Uint8Array): Promise<SubKeys> {
  const expand = (label: string): Promise<Uint8Array> => {
    const l = utf8Encode(label);
    const buf = new Uint8Array(master.length + 1 + l.length);
    buf.set(master);
    buf.set(l, master.length + 1);
    return sha256(buf);
  };
  const [perm, xor, noise, mac, overlay, meta] = await Promise.all([
    expand('perm'), expand('xor'), expand('noise'), expand('mac'), expand('ovly'), expand('meta'),
  ]);
  return { perm, xor, noise, mac, overlay, meta };
}

export { hmacSha256 };

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
