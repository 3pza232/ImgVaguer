/**
 * 密钥派生：字节凭据 → 主密钥（口令走 PBKDF2-SHA256，全熵种子走 HKDF-SHA256）
 * → 标签化 SHA-256 展开子密钥。
 * 子密钥按用途隔离（置换 / 异或流 / 噪声 / MAC / 载荷 / 元数据），避免跨域复用。
 */

const enc = new TextEncoder();

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** 由低熵凭据（口令）派生 256 位主密钥：PBKDF2 的迭代拉伸用于抬高枚举成本 */
export async function deriveMasterKey(
  secret: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * HKDF-SHA256 单块派生（RFC 5869，输出 32B）。
 * 用于全熵凭据（密钥文件种子 / 内嵌种子）：对高熵密钥做迭代拉伸不增加任何强度，
 * 只会平白耗费数秒；info 用于隔离不同用途的派生域。
 */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
): Promise<Uint8Array> {
  const label = enc.encode(info);
  const block = new Uint8Array(label.length + 1);
  block.set(label);
  block[label.length] = 1;
  return hmacSha256(await hmacSha256(salt, ikm), block);
}

/** 口令字符串 → 字节凭据 */
export function passwordBytes(password: string): Uint8Array {
  return enc.encode(password);
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
    const l = enc.encode(label);
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

export async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
