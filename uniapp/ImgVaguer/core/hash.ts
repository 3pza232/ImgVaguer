/**
 * 摘要与派生原语：WebCrypto 快路径 + 纯 TS 兜底。
 * App / 小程序 webview 常无 crypto.subtle，PBKDF2 又处在加密/解密的最前端，
 * 故纯 TS 路径按"每轮只做必要压缩、全程复用缓冲"实现。
 * 两条路径输出逐位一致（纯 TS 实现经官方测试向量校验，见 tests/hash.test.ts）。
 */

/** 原生 WebCrypto（存在则用），不存在返回 null */
function subtle(): SubtleCrypto | null {
  const c = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto;
  return c && c.subtle ? c.subtle : null;
}

const HASH_IV = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 复用的消息扩展缓冲：PBKDF2 每轮压缩数十万次，逐次分配会成为热点 */
const W = new Uint32Array(64);

/** 压缩 buf[pos, pos+64) 一个块，就地更新状态 h */
function compressBlock(h: Uint32Array, buf: Uint8Array, pos: number): void {
  for (let i = 0; i < 16; i++) {
    const p = pos + i * 4;
    W[i] = ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;
  }
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15];
    const b = W[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
  }

  let a = h[0];
  let b = h[1];
  let c = h[2];
  let d = h[3];
  let e = h[4];
  let f = h[5];
  let g = h[6];
  let hh = h[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + S1 + ch + K[i] + W[i]) >>> 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) >>> 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  h[0] = (h[0] + a) >>> 0;
  h[1] = (h[1] + b) >>> 0;
  h[2] = (h[2] + c) >>> 0;
  h[3] = (h[3] + d) >>> 0;
  h[4] = (h[4] + e) >>> 0;
  h[5] = (h[5] + f) >>> 0;
  h[6] = (h[6] + g) >>> 0;
  h[7] = (h[7] + hh) >>> 0;
}

/** 状态 → 32 字节大端摘要 */
function squeeze(h: Uint32Array, out: Uint8Array, pos = 0): void {
  for (let i = 0; i < 8; i++) {
    const v = h[i];
    const p = pos + i * 4;
    out[p] = (v >>> 24) & 0xff;
    out[p + 1] = (v >>> 16) & 0xff;
    out[p + 2] = (v >>> 8) & 0xff;
    out[p + 3] = v & 0xff;
  }
}

/** SHA-256（纯 TS，导出便于测试向量校验） */
export function sha256Sync(data: Uint8Array): Uint8Array {
  const len = data.length;
  const padded = (len + 9 + 63) & ~63;
  const buf = new Uint8Array(padded);
  buf.set(data);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padded - 8, Math.floor(len / 0x20000000));
  dv.setUint32(padded - 4, (len << 3) >>> 0);

  const h = new Uint32Array(HASH_IV);
  for (let i = 0; i < padded; i += 64) compressBlock(h, buf, i);
  const out = new Uint8Array(32);
  squeeze(h, out);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** HMAC-SHA256（纯 TS 一次式，导出便于测试向量校验；PBKDF2 走下方专用迭代器） */
export function hmacSha256Sync(keyBytes: Uint8Array, data: Uint8Array): Uint8Array {
  const key = keyBytes.length > 64 ? sha256Sync(keyBytes) : keyBytes;
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const b = i < key.length ? key[i] : 0;
    ipad[i] = b ^ 0x36;
    opad[i] = b ^ 0x5c;
  }
  return sha256Sync(concat(opad, sha256Sync(concat(ipad, data))));
}

/** PBKDF2 单轮 PRF 的输入上限：短于 56 字节时内层恰好只多压缩一个块 */
const PRF_MAX_MSG = 55;

/**
 * 固定密钥的 HMAC-SHA256 迭代器，面向 PBKDF2 的短消息（≤ 55 字节）。
 *
 * 内层除 ipad 首块外的内容与外层除 opad 首块外的内容各只占一个块，
 * 故把两个首块的状态预先算好，每轮压缩次数由 4 降到 2，且全程复用缓冲。
 * @param msg 待认证消息；与 out 可指向同一缓冲
 */
function hmacIterator(keyBytes: Uint8Array): (msg: Uint8Array, out: Uint8Array) => void {
  const key = keyBytes.length > 64 ? sha256Sync(keyBytes) : keyBytes;
  const innerBase = new Uint32Array(8);
  const outerBase = new Uint32Array(8);
  const pad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) pad[i] = (i < key.length ? key[i] : 0) ^ 0x36;
  innerBase.set(HASH_IV);
  compressBlock(innerBase, pad, 0);
  for (let i = 0; i < 64; i++) pad[i] = (i < key.length ? key[i] : 0) ^ 0x5c;
  outerBase.set(HASH_IV);
  compressBlock(outerBase, pad, 0);

  // 内层补位随消息长度变化（PBKDF2 只在首轮 U1 与后续轮之间切换），故按长度缓存；
  // 外层载荷恒为 32 字节摘要，补位可一次写死。
  const inBlock = new Uint8Array(64);
  const outBlock = new Uint8Array(64);
  outBlock[32] = 0x80;
  outBlock[62] = 0x03; // (64 + 32) * 8 = 768
  const state = new Uint32Array(8);
  let paddedLen = -1;

  return (msg, out) => {
    if (msg.length > PRF_MAX_MSG) throw new Error('PRF 消息过长');
    if (msg.length !== paddedLen) {
      paddedLen = msg.length;
      const bits = (64 + msg.length) * 8;
      inBlock.fill(0, msg.length);
      inBlock[msg.length] = 0x80;
      inBlock[62] = (bits >>> 8) & 0xff;
      inBlock[63] = bits & 0xff;
    }
    inBlock.set(msg, 0);

    state.set(innerBase);
    compressBlock(state, inBlock, 0);
    squeeze(state, outBlock); // 内层摘要直接落在外层块的载荷区

    state.set(outerBase);
    compressBlock(state, outBlock, 0);
    squeeze(state, out);
  };
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const s = subtle();
  if (s) return new Uint8Array(await s.digest('SHA-256', data as unknown as BufferSource));
  return sha256Sync(data);
}

export async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const s = subtle();
  if (s) {
    const key = await s.importKey('raw', keyBytes as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await s.sign('HMAC', key, data as unknown as BufferSource));
  }
  return hmacSha256Sync(keyBytes, data);
}

const oneBlock = new Uint8Array([0, 0, 0, 1]);

/** 纯 TS 每这么多轮让出一次主线程：兼顾界面可重绘与让出本身的调度开销 */
const YIELD_INTERVAL = 0x3fff;

/**
 * PBKDF2-HMAC-SHA256（32 字节输出）。
 * 纯 TS 路径按固定间隔让出主线程，避免长迭代期间界面完全冻结。
 */
export async function pbkdf2(secret: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const s = subtle();
  if (s) {
    const base = await s.importKey('raw', secret as unknown as BufferSource, 'PBKDF2', false, ['deriveBits']);
    const bits = await s.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
      base,
      256,
    );
    return new Uint8Array(bits);
  }

  const prf = hmacIterator(secret);
  const u = new Uint8Array(32);
  const t = new Uint8Array(32);
  prf(concat(salt, oneBlock), u);
  t.set(u);
  for (let i = 1; i < iterations; i++) {
    prf(u, u);
    for (let j = 0; j < 32; j++) t[j] ^= u[j];
    if ((i & YIELD_INTERVAL) === 0) await new Promise<void>((r) => setTimeout(r, 0));
  }
  return t;
}
