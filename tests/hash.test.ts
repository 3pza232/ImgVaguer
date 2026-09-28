/**
 * 移动端纯 TS 凭据原语校验：官方测试向量 + 与平台原生实现的逐位一致性。
 *
 * App / 小程序通常没有 crypto.subtle 与 TextEncoder，派生与凭据编码全走内置实现。
 * 这两者决定主密钥，任一处与桌面端不一致都会导致跨端文件无法还原，
 * 故这里既比对标准向量，也移除原生实现后用同一输入交叉验证。
 */
import { hmacSha256, hmacSha256Sync, pbkdf2, sha256, sha256Sync } from '../uniapp/ImgVaguer/core/hash';
import { utf8Decode, utf8Encode } from '../uniapp/ImgVaguer/core/text';
import { afterEach, describe, expect, it, vi } from 'vitest';

const realCrypto = globalThis.crypto;
const realSubtle = realCrypto.subtle;

/** 移除 WebCrypto，迫使后续调用走纯 TS 兜底路径（保留随机源） */
function withoutWebCrypto(): void {
  vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => realCrypto.getRandomValues(a) });
}
afterEach(() => vi.unstubAllGlobals());

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function repeat(byte: number, n: number): Uint8Array {
  return new Uint8Array(n).fill(byte);
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) b.set(realCrypto.getRandomValues(new Uint8Array(Math.min(65536, n - o))), o);
  return b;
}

describe('utf8', () => {
  const samples = [
    '', 'ascii', 'pässwörd', '中文字符串', '日本語テスト', '😀🎉', 'a中😀z',
    '\ud800', '\udc00', 'ab\ud83d\ude00cd',
  ];

  it('编码与 TextEncoder 逐位一致', () => {
    for (const s of samples) expect(hex(utf8Encode(s))).toBe(hex(new TextEncoder().encode(s)));
  });

  it('解码与 TextDecoder 一致', () => {
    for (const s of samples) {
      const bytes = new TextEncoder().encode(s);
      expect(utf8Decode(bytes)).toBe(new TextDecoder().decode(bytes));
    }
  });
});

describe('sha256', () => {
  it('NIST 测试向量', () => {
    expect(hex(sha256Sync(new Uint8Array(0))))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(sha256Sync(utf8('abc'))))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(sha256Sync(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('覆盖补位与多块边界', async () => {
    for (const n of [1, 54, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const data = randomBytes(n);
      const native = new Uint8Array(await realSubtle.digest('SHA-256', data));
      expect(hex(sha256Sync(data))).toBe(hex(native));
    }
  });

  it('兜底路径与 WebCrypto 一致', async () => {
    const data = randomBytes(200);
    const native = hex(new Uint8Array(await realSubtle.digest('SHA-256', data)));
    withoutWebCrypto();
    expect(hex(await sha256(data))).toBe(native);
  });
});

describe('hmacSha256', () => {
  it('RFC 4231 测试向量', () => {
    expect(hex(hmacSha256Sync(repeat(0x0b, 20), utf8('Hi There'))))
      .toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
    expect(hex(hmacSha256Sync(utf8('Jefe'), utf8('what do ya want for nothing?'))))
      .toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
    expect(hex(hmacSha256Sync(repeat(0xaa, 20), repeat(0xdd, 50))))
      .toBe('773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe');
    // 超过块长的密钥需先哈希
    expect(hex(hmacSha256Sync(repeat(0xaa, 131), utf8(
      'This is a test using a larger than block-size key and a larger than block-size data. '
      + 'The key needs to be hashed before being used by the HMAC algorithm.',
    )))).toBe('9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2');
  });

  it('兜底路径与 WebCrypto 一致（含超块长密钥与长消息）', async () => {
    const inputs = ([[16, 0], [32, 1], [64, 200], [100, 1000]] as const).map(([kn, dn]) => ({
      key: randomBytes(kn),
      data: randomBytes(dn),
    }));
    const native: string[] = [];
    for (const i of inputs) {
      const key = await realSubtle.importKey('raw', i.key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      native.push(hex(new Uint8Array(await realSubtle.sign('HMAC', key, i.data))));
    }
    withoutWebCrypto();
    inputs.forEach((i, n) => expect(hex(hmacSha256Sync(i.key, i.data))).toBe(native[n]));
    expect(hex(await hmacSha256(inputs[0].key, inputs[0].data))).toBe(native[0]);
  });
});

describe('pbkdf2', () => {
  /** RFC 7914 §11 收录的 PBKDF2-HMAC-SHA256 标准向量 */
  const vectors = [
    {
      password: 'password', salt: 'salt', c: 1,
      out: '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b',
    },
    {
      password: 'password', salt: 'salt', c: 2,
      out: 'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43',
    },
    {
      password: 'password', salt: 'salt', c: 4096,
      out: 'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a',
    },
  ];

  it('兜底路径命中标准向量', async () => {
    withoutWebCrypto();
    for (const v of vectors) {
      expect(hex(await pbkdf2(utf8(v.password), utf8(v.salt), v.c))).toBe(v.out);
    }
  });

  it('兜底路径与 WebCrypto 一致', async () => {
    const cases = [[16, 16, 1], [32, 16, 7], [8, 32, 500]] as const;
    const inputs = cases.map(([sn, an]) => ({ secret: randomBytes(sn), salt: randomBytes(an) }));
    const native: string[] = [];
    for (let i = 0; i < inputs.length; i++) {
      native.push(hex(await pbkdf2(inputs[i].secret, inputs[i].salt, cases[i][2])));
    }
    withoutWebCrypto();
    for (let i = 0; i < inputs.length; i++) {
      expect(hex(await pbkdf2(inputs[i].secret, inputs[i].salt, cases[i][2]))).toBe(native[i]);
    }
  });
});
