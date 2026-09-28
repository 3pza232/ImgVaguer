/**
 * 应用内放大预览状态。
 * 不用 uni.previewImage：App 端传 data URL 会崩溃，且样式不可控；改用主题化浮层。
 */
import { reactive } from 'vue';

export interface ZoomState {
  open: boolean;
  urls: string[];
  index: number;
}

export const zoom = reactive<ZoomState>({ open: false, urls: [], index: 0 });

export function openZoom(urls: string[], index = 0): void {
  if (!urls.length) return;
  zoom.urls = urls;
  zoom.index = Math.min(Math.max(index, 0), urls.length - 1);
  zoom.open = true;
}

export function closeZoom(): void {
  zoom.open = false;
}
