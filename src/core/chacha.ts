/**
 * ChaCha20（RFC 8439）流密码。
 * 作为全域密钥化 PRNG：置换抽样、异或流、噪声流均由此派生。
 */

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function quarter(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
}

export function chacha20Block(key: Uint8Array, counter: number, nonce: Uint8Array): Uint8Array {
  const state = new Uint32Array(16);
  state.set(SIGMA, 0);
  const kv = new DataView(key.buffer, key.byteOffset, key.byteLength);
  for (let i = 0; i < 8; i++) state[4 + i] = kv.getUint32(i * 4, true);
  state[12] = counter >>> 0;
  const nv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  for (let i = 0; i < 3; i++) state[13 + i] = nv.getUint32(i * 4, true);

  const work = new Uint32Array(state);
  for (let i = 0; i < 10; i++) {
    quarter(work, 0, 4, 8, 12); quarter(work, 1, 5, 9, 13);
    quarter(work, 2, 6, 10, 14); quarter(work, 3, 7, 11, 15);
    quarter(work, 0, 5, 10, 15); quarter(work, 1, 6, 11, 12);
    quarter(work, 2, 7, 8, 13); quarter(work, 3, 4, 9, 14);
  }
  const out = new Uint8Array(64);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) ov.setUint32(i * 4, (work[i] + state[i]) >>> 0, true);
  return out;
}

export function chacha20Stream(key: Uint8Array, nonce: Uint8Array, length: number): Uint8Array {
  return chacha20StreamAt(key, nonce, 0, length);
}

/** 从流中任意字节偏移处取 length 字节，支持分块处理大图 */
export function chacha20StreamAt(
  key: Uint8Array,
  nonce: Uint8Array,
  byteOffset: number,
  length: number,
): Uint8Array {
  const out = new Uint8Array(length);
  let counter = Math.floor(byteOffset / 64);
  let skip = byteOffset % 64;
  let written = 0;
  while (written < length) {
    const block = chacha20Block(key, counter, nonce);
    counter = (counter + 1) >>> 0;
    const start = skip;
    skip = 0;
    const take = Math.min(64 - start, length - written);
    out.set(block.subarray(start, start + take), written);
    written += take;
  }
  return out;
}

/** 就地异或（对称加密） */
export function chacha20Xor(key: Uint8Array, nonce: Uint8Array, data: Uint8Array): void {
  let counter = 0;
  let offset = 0;
  while (offset < data.length) {
    const block = chacha20Block(key, counter, nonce);
    counter = (counter + 1) >>> 0;
    const take = Math.min(64, data.length - offset);
    for (let i = 0; i < take; i++) data[offset + i] ^= block[i];
    offset += take;
  }
}
