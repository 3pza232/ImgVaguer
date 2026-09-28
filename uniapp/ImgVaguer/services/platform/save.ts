/**
 * 结果导出（非 App 通道）：图片走 H5 下载 / 小程序相册；文本 .ivkey 走 H5 下载 / 小程序复制。
 * App 端统一由 services/export.ts 写入用户所选文件夹，不在此处理。
 */
// #ifdef MP-WEIXIN
import { writeTempFile } from './image-io';
// #endif

export interface SaveOutcome {
  ok: boolean;
  message: string;
}

function toast(title: string): void {
  uni.showToast({ title, icon: 'none', duration: 2000 });
}

/** 保存图片：H5 下载 / 小程序相册（App 见 services/export.ts）；mime 由文件扩展名决定 */
export async function saveImage(bytes: Uint8Array, name: string, mime = 'image/png'): Promise<SaveOutcome> {
  // #ifdef H5
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return { ok: true, message: `${name} 已下载` };
  } catch {
    const win = window.open(url, '_blank');
    return win
      ? { ok: true, message: '已在新标签打开，请右键另存' }
      : { ok: false, message: '浏览器拦截了下载，请改用 App 端或在预览中长按保存' };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  // #endif
  // #ifdef MP-WEIXIN
  const path = writeTempFile(bytes, name);
  try {
    await new Promise<void>((resolve, reject) => {
      wx.saveImageToPhotosAlbum({
        filePath: path,
        success: () => resolve(),
        fail: (e: { errMsg?: string }) => reject(new Error(e.errMsg ?? '保存失败')),
      });
    });
    return { ok: true, message: `${name} 已保存到相册` };
  } catch (e) {
    return { ok: false, message: `保存失败：${(e as Error).message}` };
  }
  // #endif
  // #ifdef APP-PLUS
  void mime;
  return { ok: false, message: 'App 端图片导出走 services/export 通道，不应调用此项' };
  // #endif
}

/**
 * 导出文本（密钥文件）：
 * H5 直接下载；小程序/App 复制到剪贴板（App 的「另存」由页面另提供保存面板）。
 */
export function exportText(text: string, name: string): SaveOutcome {
  // #ifdef H5
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return { ok: true, message: `${name} 已下载` };
  } catch {
    const win = window.open(url, '_blank');
    return win ? { ok: true, message: '已在新标签打开，请右键另存' } : { ok: false, message: '浏览器拦截了下载，请改用复制' };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  // #endif
  // #ifndef H5
  copyText(text);
  return { ok: true, message: '密钥内容已复制到剪贴板，请妥善保存' };
  // #endif
}

/** 复制文本到剪贴板 */
export function copyText(text: string): void {
  uni.setClipboardData({ data: text, success: () => toast('已复制到剪贴板') });
}

/** 读取剪贴板文本（小程序/App 载入密钥的兜底通道） */
export function readClipboard(): Promise<string> {
  return new Promise((resolve) => {
    uni.getClipboardData({
      success: (res: { data?: string }) => resolve(res.data ?? ''),
      fail: () => resolve(''),
    });
  });
}
