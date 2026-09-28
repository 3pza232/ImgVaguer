/**
 * App / 小程序端解码所用隐藏画布的尺寸桥。
 * 旧版 canvas（createCanvasContext）的绘图区等于元素尺寸，读像素前须先把画布
 * 调整到目标尺寸；故由 image-io 在解码前设置，页面据此渲染对应尺寸的隐藏 canvas。
 */
import { nextTick, reactive } from 'vue';

export const canvasBox = reactive({ width: 1, height: 1 });

export async function resizeCanvas(width: number, height: number): Promise<void> {
  canvasBox.width = width;
  canvasBox.height = height;
  await nextTick();
  // 再让出一帧，确保原生画布已按新尺寸重建，避免绘制落在旧绘图区
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
