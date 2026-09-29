/**
 * 性能分析：把一次批处理的逐张耗时与产出台账，整理成界面可直接消费的视图数据。
 *
 * 这里只做纯计算（求和、占比、极值）与文本格式化，不含平台 API 与渲染逻辑：
 * 桌面端与移动端共用同一份聚合规则、同一套术语，两端的「性能分析」面板才不会各算一套。
 */
import type { Mode } from './types';

/** 四段耗时。四段互不重叠，合计即该张的端到端耗时 */
export type StageKey = 'kdf' | 'payload' | 'pixels' | 'output';

export interface StageTimes {
  /** 密钥派生：口令拉伸、密钥文件解析 */
  kdf: number;
  /** 载荷处理：打包、压缩、加解密 */
  payload: number;
  /** 像素处理：位图解码、密文混淆、覆盖合成 */
  pixels: number;
  /** 输出封装：PNG 编码与数据块写入；解密端为还原结果落地 */
  output: number;
}

/** 分段顺序、叫法与释义：两端界面与使用文档共用，避免同一个量出现两种名字 */
export const STAGE_ORDER: readonly StageKey[] = ['kdf', 'payload', 'pixels', 'output'];
export const STAGE_LABELS: Record<StageKey, string> = {
  kdf: '密钥派生',
  payload: '载荷处理',
  pixels: '像素处理',
  output: '输出封装',
};
export const STAGE_HINTS: Record<StageKey, string> = {
  kdf: '由口令或密钥文件推算出加密密钥。迭代次数越高越慢；密钥文件与「无保护」几乎不耗时。',
  payload: '把原图打包压缩后加密（或解密时反向取出），耗时主要取决于原文件大小。',
  pixels: '解码位图并做密文混淆 / 覆盖合成。只有需要真实像素的设置有这一段。',
  output: '把结果编码成 PNG 并写入数据块，或把还原结果交回界面。',
};

/**
 * 一次运行中的进度：按张推进，并显示当前这张正处在哪一段。
 * 段名直接复用上面的四段，界面上因此不会出现第二套说法。
 */
export interface RunProgress {
  /** 当前在做什么：如「加密 a.png」「载入图像…」 */
  label: string;
  /** 已完成张数 */
  done: number;
  total: number;
  /** 当前阶段；不在处理图像时（如准备阶段）为 null */
  stage: StageKey | null;
}

/** 阶段进度回调：引擎在每段开始时上报一次，界面据此更新 RunProgress.stage */
export type StageProgress = (stage: StageKey) => void;

/** 单张图像的处理记录 */
export interface ItemStat {
  name: string;
  ok: boolean;
  /** 输入字节：加密为原文件大小，解密为加密图大小 */
  inBytes: number;
  /** 产出字节：加密为输出图大小，解密为还原出的原文件大小 */
  outBytes: number;
  /** 该张端到端耗时（毫秒） */
  ms: number;
  /** 像素数（宽 × 高），解密时按还原结果计 */
  pixels: number;
  /** 该张的耗时构成 */
  stages: StageTimes;
}

/** 一次批处理的完整台账，随结果批次一同保存 */
export interface BatchStats {
  op: 'encrypt' | 'decrypt';
  /** 混淆方式；解密批次可能混合多种方式（加密时才会为已知值） */
  mode: Mode | null;
  /** 批次端到端耗时，含导出、打包等批级开销 */
  totalMs: number;
  items: ItemStat[];
}

/** 汇总结果：界面上的每个数字都取自这里，不重复计算 */
export interface StatsSummary {
  count: number;
  okCount: number;
  failCount: number;
  /** 各张耗时之和 */
  itemMs: number;
  /** 批次端到端耗时 */
  totalMs: number;
  /** 批级开销 = 总耗时 − 各张耗时之和（导出、打包、界面刷新等） */
  overheadMs: number;
  avgMs: number;
  maxMs: number;
  /** 最慢的一张 */
  slowest: ItemStat | null;
  inBytes: number;
  outBytes: number;
  /** 产出 / 输入（体积倍数；输入为 0 时为 0） */
  sizeRatio: number;
  /** 总像素吞吐（万像素 / 秒；耗时或像素为 0 时为 0） */
  tenKPixelsPerSec: number;
  /** 四段耗时合计，用于构成图 */
  stages: StageTimes;
}

export const EMPTY_STAGES: StageTimes = { kdf: 0, payload: 0, pixels: 0, output: 0 };

/** 空台账：每次执行先建台账、逐张登记，最后一个批次对应一份 */
export function emptyStats(op: 'encrypt' | 'decrypt', mode: Mode | null): BatchStats {
  return { op, mode, totalMs: 0, items: [] };
}

/**
 * 输出段 = 该张总耗时 − 前三段。
 * 这样四段必然等于总耗时，生成预览、取 URL、落地写盘等零散开销也归入输出段，
 * 不必为每种操作再拆一套口径。
 */
export function withOutputStage(ms: number, stages: StageTimes): StageTimes {
  const rest = ms - stages.kdf - stages.payload - stages.pixels;
  return { ...stages, output: rest > 0 ? rest : 0 };
}

/**
 * 记账：成功一项。
 * 「四段必须等于总耗时」这条规则只在 withOutputStage 里实现一次，
 * 两端都走这里入账，就不会出现一边算了输出段、另一边忘了的情况。
 */
export function recordOk(
  stats: BatchStats,
  o: { name: string; inBytes: number; outBytes: number; ms: number; pixels: number; timings: StageTimes },
): void {
  stats.items.push(itemStat({ ...o, stages: withOutputStage(o.ms, o.timings) }));
}

/** 记账：失败一项（只有总耗时，分段留空） */
export function recordFail(
  stats: BatchStats,
  o: { name: string; inBytes: number; ms: number; pixels: number },
): void {
  stats.items.push(itemStat({ ...o, ok: false }));
}

/** 登记一张的台账（未提供分段时记为全 0，用于失败项） */
export function itemStat(fields: {
  name: string;
  inBytes: number;
  outBytes?: number;
  ms: number;
  pixels?: number;
  stages?: StageTimes;
  ok?: boolean;
}): ItemStat {
  return {
    name: fields.name,
    ok: fields.ok ?? true,
    inBytes: fields.inBytes,
    outBytes: fields.outBytes ?? 0,
    ms: fields.ms,
    pixels: fields.pixels ?? 0,
    stages: fields.stages ?? { ...EMPTY_STAGES },
  };
}

export function stageTimesOf(s: Partial<StageTimes> | undefined): StageTimes {
  return {
    kdf: s?.kdf ?? 0,
    payload: s?.payload ?? 0,
    pixels: s?.pixels ?? 0,
    output: s?.output ?? 0,
  };
}

export function addStages(a: StageTimes, b: StageTimes): StageTimes {
  return {
    kdf: a.kdf + b.kdf,
    payload: a.payload + b.payload,
    pixels: a.pixels + b.pixels,
    output: a.output + b.output,
  };
}

/** 汇总一批统计数据 */
export function summarize(stats: BatchStats): StatsSummary {
  const items = stats.items;
  const itemMs = items.reduce((n, i) => n + i.ms, 0);
  const inBytes = items.reduce((n, i) => n + i.inBytes, 0);
  const outBytes = items.reduce((n, i) => n + i.outBytes, 0);
  const pixels = items.reduce((n, i) => n + i.pixels, 0);
  const slowest = items.reduce<ItemStat | null>((a, b) => (a === null || b.ms > a.ms ? b : a), null);
  const totalMs = stats.totalMs;
  return {
    count: items.length,
    okCount: items.filter((i) => i.ok).length,
    failCount: items.filter((i) => !i.ok).length,
    itemMs,
    totalMs,
    overheadMs: Math.max(0, totalMs - itemMs),
    avgMs: items.length ? itemMs / items.length : 0,
    maxMs: slowest?.ms ?? 0,
    slowest,
    inBytes,
    outBytes,
    sizeRatio: inBytes > 0 ? outBytes / inBytes : 0,
    tenKPixelsPerSec: totalMs > 0 && pixels > 0 ? pixels / (totalMs / 1000) / 10000 : 0,
    stages: items.reduce((acc, i) => addStages(acc, i.stages), { ...EMPTY_STAGES }),
  };
}

/**
 * 一组绝对量 → 整数百分比，合计恒为 100。
 * 用最大余数法补足，避免构成图出现 99% 或 101% 这类自相矛盾的读数；
 * 全为 0 时返回全 0，界面据此显示「无可分解耗时」。
 */
export function shares(values: number[]): number[] {
  const total = values.reduce((n, v) => n + v, 0);
  // 全零：没有可分摊的时间，返回全 0（否则会平白分掉 100，给出「每项 1%」这种假读数）
  if (total <= 0) return values.map(() => 0);
  const floors = values.map((v) => Math.floor((v / total) * 100));
  let rest = 100 - floors.reduce((a, b) => a + b, 0);
  const byFraction = values
    .map((v, i) => ({ i, frac: (v / total) * 100 - floors[i] }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of byFraction) {
    if (rest <= 0) break;
    floors[i]++;
    rest--;
  }
  return floors;
}

/** 四段耗时的占比 */
export function stagePercents(stages: StageTimes): { key: StageKey; percent: number }[] {
  const percents = shares(STAGE_ORDER.map((k) => stages[k]));
  return STAGE_ORDER.map((key, i) => ({ key, percent: percents[i] }));
}

/** 批级开销的默认名字（不属于四段耗时，故单独给出） */
export const OVERHEAD_LABEL = '批级开销';

/**
 * 批级开销的名字：需要图层的混淆方式会额外包含一次整批共用的图层解码，
 * 那部分耗时不属于任何单张，故在名字里点明——它既不是导出，也不是打包，
 * 导出 / 打包要等用户点按钮才发生，不在本批耗时之内。
 */
export function overheadLabel(mode: Mode | null): string {
  return mode === 'overlay' || mode === 'hybrid' ? '图层与批级开销' : OVERHEAD_LABEL;
}

/** 构成图的切片：四段耗时 + 批级开销，份额按五项一起归一，读数才是真实的 */
export interface Slice {
  key: StageKey | 'overhead';
  label: string;
  value: number;
  percent: number;
}

export function composeSlices(s: StatsSummary, overhead = OVERHEAD_LABEL): Slice[] {
  const buckets: { key: Slice['key']; label: string; value: number }[] = STAGE_ORDER.map((k) => ({
    key: k,
    label: STAGE_LABELS[k],
    value: s.stages[k],
  }));
  if (s.overheadMs > 0) buckets.push({ key: 'overhead', label: overhead, value: s.overheadMs });
  const percents = shares(buckets.map((b) => b.value));
  return buckets.map((b, i) => ({ ...b, percent: percents[i] }));
}

/** 逐张明细行：条长按最慢一张归一（便于横向比较），份额是该张占批次的比例 */
export interface StatRow {
  name: string;
  ok: boolean;
  ms: number;
  percent: number;
  width: number;
}

export function statRows(stats: BatchStats, s: StatsSummary): StatRow[] {
  const percents = shares(stats.items.map((i) => i.ms));
  return stats.items.map((it, i) => ({
    name: it.name,
    ok: it.ok,
    ms: it.ms,
    percent: percents[i],
    width: s.maxMs > 0 ? Math.max(2, (it.ms / s.maxMs) * 100) : 0,
  }));
}

/** 字节数 → 人类可读（B / KB / MB / GB） */
export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 毫秒 → 人类可读（ms / s），低于 10ms 保留一位小数以便看出差异 */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** 体积倍数 → ×1.02 形式 */
export function formatRatio(r: number): string {
  return `×${r.toFixed(2)}`;
}
