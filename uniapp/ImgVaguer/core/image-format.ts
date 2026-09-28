/**
 * 图像命名（纯 TS，无平台依赖，可单测）。
 *
 * 背景：各端选图接口普遍不返回原始文件名——H5 给的是 blob URL、App/小程序给的是
 * 临时路径，直接取路径基名会全部退化为同一个兜底名（曾导致列表与导出重名）。
 * 故命名按三级降级：选择器原始名 → 带图像扩展名的路径基名 → 依类型推断扩展名的序号名。
 */

export type ImageFormat = 'png' | 'jpg' | 'gif' | 'webp' | 'bmp';

const EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** 路径基名：仅当带可信图像扩展名时返回，否则 null */
function baseNameOf(path: string): string | null {
  const seg = path.split(/[\\/]/).pop() ?? '';
  return EXT_RE.test(seg) ? seg : null;
}

/** 序号自增，保证无原始文件名时同批不重名 */
let unnamedSeq = 0;

/** 命名决策：原始名 → 路径基名 → 兜底序号名（扩展名依图像类型，不误标格式） */
export function pickImageName(provided: string | undefined, path: string, format: ImageFormat | null): string {
  if (provided) return provided;
  const base = baseNameOf(path);
  if (base) return base;
  unnamedSeq += 1;
  return `image-${unnamedSeq}.${format ?? 'png'}`;
}
