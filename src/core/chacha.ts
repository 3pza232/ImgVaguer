/**
 * ChaCha20（RFC 8439）流密码。
 * 作为全域密钥化 PRNG：置换抽样、异或流、噪声流、装饰噪声均由此派生。
 *
 * 实现要点：密钥与 nonce 只装载一次，块运算全程复用同一组缓冲。
 * 原实现每 64 字节新建 state / work / DataView / 输出缓冲，
 * 在千万级调用的逐像素变换中会产生等量对象分配与 GC 抖动，是移动端卡顿的主因。
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

/** 逐图 IV 长度（12B nonce 中除域字节外的部分） */
export const IV_LEN = 11;

/**
 * 以域字节 + 逐图 IV 组装 12B nonce。
 * 同一 IV 下不同域互不重复；不同 IV 下同域亦不重复，
 * 保证「同密钥 + 不同图像」绝不共享密钥流。
 */
export function ivNonce(iv: Uint8Array, domain: number): Uint8Array {
  const n = new Uint8Array(12);
  n[0] = domain;
  n.set(iv.subarray(0, IV_LEN), 1);
  return n;
}

/** 随机取数缓冲长度：一次性取满后按 u32 消费，避免逐次取流 */
const RAND_CHUNK = 1024;

export class ChaCha20 {
  private readonly state = new Uint32Array(16);
  private readonly work = new Uint32Array(16);
  private readonly block = new Uint8Array(64);
  private readonly rand = new Uint8Array(RAND_CHUNK);
  private randPos = RAND_CHUNK;
  private randBlock = 0;

  constructor(key: Uint8Array, nonce: Uint8Array) {
    const s = this.state;
    for (let i = 0; i < 4; i++) s[i] = SIGMA[i];
    const kv = new DataView(key.buffer, key.byteOffset, key.byteLength);
    for (let i = 0; i < 8; i++) s[4 + i] = kv.getUint32(i * 4, true);
    const nv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
    for (let i = 0; i < 3; i++) s[13 + i] = nv.getUint32(i * 4, true);
  }

  /** 生成 counter 号密钥块到内部缓冲 */
  private gen(counter: number): void {
    const s = this.state;
    const w = this.work;
    s[12] = counter >>> 0;
    w.set(s);
    for (let i = 0; i < 10; i++) {
      quarter(w, 0, 4, 8, 12); quarter(w, 1, 5, 9, 13);
      quarter(w, 2, 6, 10, 14); quarter(w, 3, 7, 11, 15);
      quarter(w, 0, 5, 10, 15); quarter(w, 1, 6, 11, 12);
      quarter(w, 2, 7, 8, 13); quarter(w, 3, 4, 9, 14);
    }
    const b = this.block;
    for (let i = 0; i < 16; i++) {
      const x = (w[i] + s[i]) >>> 0;
      const o = i * 4;
      b[o] = x & 0xff;
      b[o + 1] = (x >>> 8) & 0xff;
      b[o + 2] = (x >>> 16) & 0xff;
      b[o + 3] = (x >>> 24) & 0xff;
    }
  }

  /**
   * 生成密钥流：从 streamOffset 起取 length 字节写入 dst[dstOffset..]。
   * 支持任意字节偏移与分块调用，便于按行处理大图以控制内存。
   */
  streamInto(dst: Uint8Array, streamOffset: number, length: number, dstOffset = 0): void {
    let counter = Math.floor(streamOffset / 64);
    let skip = streamOffset % 64;
    let written = 0;
    while (written < length) {
      this.gen(counter++);
      const take = Math.min(64 - skip, length - written);
      const base = dstOffset + written;
      const b = this.block;
      for (let i = 0; i < take; i++) dst[base + i] = b[skip + i];
      written += take;
      skip = 0;
    }
  }

  /** 就地把 dst[dstOffset..dstOffset+length) 与密钥流（counter 自 0 起）异或；length 缺省为余下全部 */
  xor(dst: Uint8Array, dstOffset = 0, length: number = dst.length - dstOffset): void {
    let counter = 0;
    let o = dstOffset;
    const end = dstOffset + length;
    while (o < end) {
      this.gen(counter++);
      const take = Math.min(64, end - o);
      const b = this.block;
      for (let i = 0; i < take; i++) dst[o + i] ^= b[i];
      o += take;
    }
  }

  /** [0, n) 的均匀随机整数（拒绝采样消除模偏） */
  below(n: number): number {
    if (n <= 1) return 0;
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) {
      const x = this.nextU32();
      if (x < limit) return x % n;
    }
  }

  private nextU32(): number {
    if (this.randPos === RAND_CHUNK) {
      this.streamInto(this.rand, this.randBlock * RAND_CHUNK, RAND_CHUNK);
      this.randBlock++;
      this.randPos = 0;
    }
    const p = this.randPos;
    this.randPos = p + 4;
    const b = this.rand;
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  }
}
