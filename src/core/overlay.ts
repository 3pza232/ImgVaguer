/**
 * 覆盖合成：将 cover 按不透明度混合到 target 上。
 * 原图不依赖混合可逆性，而是压缩+加密后放入 PNG chunk，还原时整体取回。
 */
import type { Raster } from './types';

/** cover 需已缩放至与 target 同尺寸（由服务层完成）；标准 alpha-over 混合 */
export function composite(target: Raster, cover: Raster, opacity: number): Raster {
  const data = target.data.slice();
  const c = cover.data;
  for (let i = 0; i < data.length; i += 4) {
    const ca = (c[i + 3] / 255) * opacity;
    if (ca <= 0) continue;
    const ta = data[i + 3] / 255;
    const outA = ca + ta * (1 - ca);
    if (outA <= 0) continue;
    data[i] = Math.round((c[i] * ca + data[i] * ta * (1 - ca)) / outA);
    data[i + 1] = Math.round((c[i + 1] * ca + data[i + 1] * ta * (1 - ca)) / outA);
    data[i + 2] = Math.round((c[i + 2] * ca + data[i + 2] * ta * (1 - ca)) / outA);
    data[i + 3] = Math.round(255 * outA);
  }
  return { width: target.width, height: target.height, data };
}

/**
 * 多层叠图：covers 按顺序叠加，target 插入第 targetLayer 层
 * （targetLayer = 位于 target 下方的覆盖图数量；0 = 目标在最底层，完全遮盖）。
 */
export function compositeLayers(target: Raster, covers: Raster[], opacity: number, targetLayer: number): Raster {
  const seq: { r: Raster; o: number }[] = covers.map((r) => ({ r, o: opacity }));
  seq.splice(Math.min(Math.max(targetLayer, 0), covers.length), 0, { r: target, o: 1 });
  let acc = seq[0].r;
  for (let i = 1; i < seq.length; i++) acc = composite(acc, seq[i].r, seq[i].o);
  return acc;
}
