/**
 * Base64 编解码（纯 TS）：小程序 runtime 不提供 btoa/atob，故自带实现。
 *
 * 两端都按"查表 + 分段聚合"实现：解码逐字符 indexOf、编码逐字符拼接字符串，
 * 都会在整张图（App 端读文件即经此还原字节）上慢一个数量级。
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 字符码 → 6 位值；非 Base64 字符为 255，用于剔除填充与空白 */
const DECODE = ((): Uint8Array => {
  const t = new Uint8Array(256).fill(255);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** 每次聚合的字符数：一次 fromCharCode 传太多参会超出引擎的实参上限 */
const CHUNK = 8192;
/** 每轮处理的字节组数（1 组 3 字节 → 4 字符） */
const GROUPS = CHUNK / 4;

export function toBase64(bytes: Uint8Array): string {
  const groups = Math.ceil(bytes.length / 3);
  const parts: string[] = [];
  for (let g = 0; g < groups; g += GROUPS) {
    const count = Math.min(GROUPS, groups - g);
    const codes = new Array<number>(count * 4);
    for (let k = 0; k < count; k++) {
      const i = (g + k) * 3;
      const b0 = bytes[i];
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      const at = k * 4;
      codes[at] = B64.charCodeAt(b0 >> 2);
      codes[at + 1] = B64.charCodeAt(((b0 & 3) << 4) | ((b1 ?? 0) >> 4));
      codes[at + 2] = i + 1 < bytes.length ? B64.charCodeAt(((b1 & 15) << 2) | ((b2 ?? 0) >> 6)) : 61; // '='
      codes[at + 3] = i + 2 < bytes.length ? B64.charCodeAt(b2 & 63) : 61;
    }
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join('');
}

export function fromBase64(text: string): Uint8Array {
  const n = text.length;
  // 末尾至多两个填充字符，据此定长，避免整幅补齐后再拷贝一次
  const pad = n >= 2 && text.charCodeAt(n - 1) === 61 ? (text.charCodeAt(n - 2) === 61 ? 2 : 1) : 0;
  const out = new Uint8Array(((n - pad) * 3) >> 2);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    const v = DECODE[text.charCodeAt(i)];
    if (v === 255) continue; // 填充与空白直接跳过
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  // 仅当输入含额外空白（长度预估偏大）时才收缩，正常情况零拷贝
  return o === out.length ? out : out.slice(0, o);
}
