/**
 * 移动端 Base64 编解码：两端都要能处理整张图的字节量，
 * 故除正确性外，还守住"不为大输入做逐字符查找/拼接"的写法（由实现方式保证，此处只验结果）。
 */
import { fromBase64, toBase64 } from '../uniapp/ImgVaguer/core/base64';
import { describe, expect, it } from 'vitest';

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

describe('base64', () => {
  it('对齐官方向量', () => {
    expect(toBase64(Uint8Array.from([0x66]))).toBe('Zg==');
    expect(toBase64(Uint8Array.from([0x66, 0x6f]))).toBe('Zm8=');
    expect(toBase64(Uint8Array.from([0x66, 0x6f, 0x6f]))).toBe('Zm9v');
    expect(toBase64(Uint8Array.from([0x66, 0x6f, 0x6f, 0x62]))).toBe('Zm9vYg==');
    expect(fromBase64('Zm9vYmFy')).toEqual(Uint8Array.from([0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72]));
  });

  it('任意长度往返一致（含各类填充与跨分段边界）', () => {
    for (const len of [0, 1, 2, 3, 4, 255, 256, 6143, 6144, 6145, 12288, 12289]) {
      const src = bytes(len, len + 7);
      expect(fromBase64(toBase64(src))).toEqual(src);
    }
  });

  it('容忍换行与空白（历史文本可能带折行）', () => {
    const src = bytes(300, 42);
    const wrapped = toBase64(src).replace(/(.{60})/g, '$1\n');
    expect(fromBase64(wrapped)).toEqual(src);
  });
});
