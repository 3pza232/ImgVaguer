/**
 * 密钥派生：PBKDF2-SHA256 → 主密钥 → 标签化 SHA-256 展开子密钥。
 * 子密钥按用途隔离（置换 / 异或流 / 噪声 / MAC / 载荷），避免跨域复用。
 */

const enc = new TextEncoder();

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export async function deriveMasterKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export interface SubKeys {
  perm: Uint8Array;
  xor: Uint8Array;
  noise: Uint8Array;
  mac: Uint8Array;
  overlay: Uint8Array;
}

export async function deriveSubKeys(master: Uint8Array): Promise<SubKeys> {
  const expand = (label: string): Promise<Uint8Array> => {
    const l = enc.encode(label);
    const buf = new Uint8Array(master.length + 1 + l.length);
    buf.set(master);
    buf.set(l, master.length + 1);
    return sha256(buf);
  };
  const [perm, xor, noise, mac, overlay] = await Promise.all([
    expand('perm'), expand('xor'), expand('noise'), expand('mac'), expand('ovly'),
  ]);
  return { perm, xor, noise, mac, overlay };
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
