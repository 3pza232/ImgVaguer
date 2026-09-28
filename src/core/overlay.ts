/**
 * 覆盖合成：将 cover 按不透明度混合到 target 上。
 * 原图不依赖混合可逆性，而是压缩+加密后放入 PNG chunk，还原时整体取回。
 */
import type { Raster } from './types';

/**
 * 就地 alpha-over：把 cover 混入 dst。
 *
 * 不透明覆盖层（ca ≥ 1，即 alpha=255 且不透明度为 1）结果就是覆盖像素本身，
 * 与完整混合算式等价（outA=1，三项加权和归一后等于 cover 分量），
 * 故走直通分支——满不透明是常规情形，这一条省掉每像素的乘除与取整。
 */
function blendInto(dst: Uint8ClampedArray, c: Uint8ClampedArray, opacity: number): void {
  for (let i = 0; i < dst.length; i += 4) {
    const ca = (c[i + 3] / 255) * opacity;
    if (ca <= 0) continue;
    if (ca >= 1) {
      dst[i] = c[i];
      dst[i + 1] = c[i + 1];
      dst[i + 2] = c[i + 2];
      dst[i + 3] = 255;
      continue;
    }
    const ta = dst[i + 3] / 255;
    const outA = ca + ta * (1 - ca);
    if (outA <= 0) continue;
    dst[i] = Math.round((c[i] * ca + dst[i] * ta * (1 - ca)) / outA);
    dst[i + 1] = Math.round((c[i + 1] * ca + dst[i + 1] * ta * (1 - ca)) / outA);
    dst[i + 2] = Math.round((c[i + 2] * ca + dst[i + 2] * ta * (1 - ca)) / outA);
    dst[i + 3] = Math.round(255 * outA);
  }
}

/**
 * 多层叠图：covers 按顺序叠加，target 插入第 targetLayer 层
 * （targetLayer = 位于 target 下方的覆盖图数量；0 = 目标在最底层，完全遮盖）。
 * 整条链只拷贝一次底图并在同一缓冲上逐层混入——逐层新建整幅位图会为大图不断制造垃圾。
 */
export function compositeLayers(target: Raster, covers: Raster[], opacity: number, targetLayer: number): Raster {
  const seq: { r: Raster; o: number }[] = covers.map((r) => ({ r, o: opacity }));
  seq.splice(Math.min(Math.max(targetLayer, 0), covers.length), 0, { r: target, o: 1 });
  const base = seq[0].r;
  if (seq.length === 1) return base;
  const data = base.data.slice();
  for (let i = 1; i < seq.length; i++) blendInto(data, seq[i].r.data, seq[i].o);
  return { width: base.width, height: base.height, data };
}
