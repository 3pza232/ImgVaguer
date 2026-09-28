/**
 * 导出通道（App）：写入「设置 → 存储位置」所选文件夹。
 *
 * 以「写入不抛错 + 落盘尺寸与入参一致」为成功判据，不做编码或转码，
 * 保证导出的 PNG 与内存中的加密结果逐字节一致（可再解密）。
 * 未选择存储位置时返回 `needDir`，由界面引导用户选择文件夹后重试。
 */
import { utf8Encode } from '@/core/text';
import type { WrittenFile } from '@/services/platform/app-storage';
// #ifdef APP-PLUS
import { settings } from '@/stores/session';
import { writeBytesToDir } from '@/services/platform/app-storage';
// #endif

/** 导出字节（image/png 等）；非 App 平台走各自平台通道，不经过此函数 */
export function exportBytes(bytes: Uint8Array, name: string, mime = 'image/png'): Promise<WrittenFile> {
  // #ifdef APP-PLUS
  const tree = settings.exportTree;
  if (!tree) return Promise.resolve({ ok: false, path: '', message: '尚未选择存储位置', needDir: true });
  return writeBytesToDir(tree.path, name, bytes, mime);
  // #endif
  // #ifndef APP-PLUS
  void bytes;
  void name;
  void mime;
  return Promise.resolve({ ok: false, path: '', message: '仅 App 端使用此通道' });
  // #endif
}

/** 导出文本（密钥文件）：UTF-8 编码后与图片同走字节通道 */
export function exportTextFile(text: string, name: string): Promise<WrittenFile> {
  return exportBytes(utf8Encode(text), name, 'text/plain');
}
