/** 轻量响应式会话状态 + localStorage 设置持久化（不引入 Pinia，保持低依赖） */
import type { BatchStats } from '@/core/stats';
import type { Mode, Protection, Raster, ScrambleLayout } from '@/core/types';
import { reactive, watch } from 'vue';

/**
 * 已选目标图。位图不在此常驻：载荷布局与多图合并只需尺寸，
 * 必要时（像素级布局 / 覆盖合成）才由 actions 按需解码，避免批量大图耗尽内存。
 */
export interface TargetItem {
  name: string;
  file: File;
  url: string;
  width: number;
  height: number;
}

/**
 * 覆盖图层：预览直接用原文件 URL，故载入只需尺寸；
 * 位图在合成时按需解码并缓存（层数受设置约束，批量加密不会重复解码）。
 */
export interface CoverItem {
  name: string;
  file: File;
  url: string;
  width: number;
  height: number;
  raster?: Raster;
}

/** 一次加密批次共用的密钥文件（供结果随时下载） */
export interface KeyFileRef {
  name: string;
  text: string;
}

export interface ResultItem {
  name: string;
  bytes: Uint8Array | null;
  url: string;
  ok: boolean;
  error?: string;
}

/** 单次执行产生的整批结果（含该批密钥文件与性能台账） */
export interface ResultBatch {
  items: ResultItem[];
  keyFile: KeyFileRef | null;
  /** 该批的性能台账；执行中或空批为 null，界面据此决定是否显示性能分析 */
  stats: BatchStats | null;
}

export type LogLevel = 'info' | 'detail';

export interface LogLine {
  time: string;
  level: LogLevel;
  text: string;
}

export interface SavedParams {
  protection: Protection;
  /** 多图合并：把本批全部目标图并入一张输出 */
  pack: boolean;
  layout: ScrambleLayout;
  iterations: number;
  blockSize: 8 | 16 | 32;
  noise: number;
  opacity: number;
  fit: 'cover' | 'stretch';
  coverQuality: number;
  rounds: number;
  globalPerm: boolean;
  sbox: boolean;
  rowshift: boolean;
}

export interface Settings {
  /** 记住参数调节 */
  rememberParams: boolean;
  defaultPassword: string;
  defaultCover: { name: string; dataUrl: string } | null;
  /** 默认覆盖图大小上限（MB） */
  defaultCoverMaxMB: number;
  /** 覆盖图层数量上限 */
  maxCoverLayers: number;
  /** 单批目标图数量上限 */
  maxTargets: number;
  /** 单张图像像素上限 */
  maxPixels: number;
  params: SavedParams;
}

const SETTINGS_KEY = 'imgvaguer.settings.v1';

const defaultParams: SavedParams = {
  protection: 'password',
  pack: false,
  layout: 'payload',
  iterations: 200000,
  blockSize: 16,
  noise: 16,
  opacity: 1,
  fit: 'cover',
  coverQuality: 1,
  rounds: 2,
  globalPerm: true,
  sbox: true,
  rowshift: true,
};

/** 合并张数上限区间：上限 12 兼顾输出体积与内存 */
export const TARGET_MIN = 1;
export const TARGET_MAX = 12;
/** 覆盖图层数上限区间 */
export const COVER_MIN = 1;
export const COVER_MAX = 6;

/** 收敛到可选区间（旧版本可能留下越界值） */
export function clampTargets(n: number): number {
  return Math.min(Math.max(Math.round(n), TARGET_MIN), TARGET_MAX);
}

/** 同上，用于覆盖图层数 */
export function clampCovers(n: number): number {
  return Math.min(Math.max(Math.round(n), COVER_MIN), COVER_MAX);
}

function loadSettings(): Settings {
  const fallback: Settings = {
    rememberParams: true,
    defaultPassword: '',
    defaultCover: null,
    defaultCoverMaxMB: 1.5,
    maxCoverLayers: 4,
    maxTargets: 9,
    maxPixels: 20_000_000,
    params: { ...defaultParams },
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      rememberParams: s.rememberParams ?? true,
      defaultPassword: s.defaultPassword ?? '',
      defaultCover: s.defaultCover ?? null,
      defaultCoverMaxMB: s.defaultCoverMaxMB ?? 1.5,
      maxCoverLayers: clampCovers(s.maxCoverLayers ?? 4),
      maxTargets: clampTargets(s.maxTargets ?? 9),
      maxPixels: s.maxPixels ?? 20_000_000,
      params: { ...defaultParams, ...(s.params ?? {}) },
    };
  } catch {
    return fallback;
  }
}

export const settings = reactive<Settings>(loadSettings());

export const store = reactive({
  /** 操作模式：加密 / 解密 */
  op: 'encrypt' as 'encrypt' | 'decrypt',
  mode: 'scramble' as Mode,
  protection: 'password' as Protection,
  /** 多图合并：把本批全部目标图并入一张输出 */
  pack: false,
  password: '',
  layout: 'payload' as ScrambleLayout,
  iterations: 200000,
  blockSize: 16 as 8 | 16 | 32,
  noise: 16,
  opacity: 1,
  fit: 'cover' as 'cover' | 'stretch',
  /** 覆盖层细节压缩 0.1..1（1=不压缩） */
  coverQuality: 1,
  /** 强化参数：变换轮数 / S 盒 / 行列移位 / 全局像素置换 */
  rounds: 2,
  globalPerm: true,
  sbox: true,
  rowshift: true,

  targets: [] as TargetItem[],
  /** 覆盖图层，按下层→上层排列 */
  covers: [] as CoverItem[],
  /** 目标图所在层：位于其下方的覆盖图数量 */
  targetLayer: 0,
  /** 解密用密钥文件 */
  keyFile: null as { name: string; seed: Uint8Array } | null,
  /** 本次进程累计的结果批次，关闭程序即清空 */
  batches: [] as ResultBatch[],
  /** 结果面板当前展示的批次序号 */
  batchIndex: 0,
  logs: [] as LogLine[],
  /** 终端视图：精简 / 详情 */
  logView: 'brief' as 'brief' | 'detail',
  busy: false,
});

// 启动时应用持久化设置（保护方式随参数一并记忆；仅首次使用默认口令方式）
if (settings.rememberParams) {
  const p = settings.params;
  Object.assign(store, {
    protection: p.protection,
    pack: p.pack,
    layout: p.layout,
    iterations: p.iterations,
    blockSize: p.blockSize,
    noise: p.noise,
    opacity: p.opacity,
    fit: p.fit,
    coverQuality: p.coverQuality,
    rounds: p.rounds,
    globalPerm: p.globalPerm,
    sbox: p.sbox,
    rowshift: p.rowshift,
  });
}

/** 口令模式下输入框为空时，自动填入设置中的默认口令（不改变保护方式） */
export function applyDefaultPassword(): void {
  if (store.protection === 'password' && !store.password && settings.defaultPassword) {
    store.password = settings.defaultPassword;
  }
}

// 手动切换到口令、或修改默认口令时，按需补全输入框
watch([() => store.protection, () => settings.defaultPassword], () => applyDefaultPassword());
applyDefaultPassword();

export function saveSettings(): void {
  settings.params = {
    protection: store.protection,
    pack: store.pack,
    layout: store.layout,
    iterations: store.iterations,
    blockSize: store.blockSize,
    noise: store.noise,
    opacity: store.opacity,
    fit: store.fit,
    coverQuality: store.coverQuality,
    rounds: store.rounds,
    globalPerm: store.globalPerm,
    sbox: store.sbox,
    rowshift: store.rowshift,
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 存储超限（如默认覆盖图过大）时静默失败，不影响使用
  }
}

// 参数变更时自动持久化
watch(
  () => [
    store.protection,
    store.pack,
    store.layout,
    store.iterations,
    store.blockSize,
    store.noise,
    store.opacity,
    store.fit,
    store.coverQuality,
    store.rounds,
    store.globalPerm,
    store.sbox,
    store.rowshift,
  ],
  () => {
    if (settings.rememberParams) saveSettings();
  },
);

function pushLog(level: LogLevel, text: string): void {
  store.logs.push({ time: new Date().toTimeString().slice(0, 8), level, text });
  if (store.logs.length > 600) store.logs.splice(0, store.logs.length - 600);
}

/** 精简日志：为用户保留的关键节点 */
export function log(msg: string): void {
  pushLog('info', msg);
}

/** 详情日志：加密/解密内部的步骤、参数与方法，仅"详情"视图展示 */
export function detail(msg: string): void {
  pushLog('detail', msg);
}

export function clearLogs(): void {
  store.logs = [];
}

/** 切换结果面板展示的批次，step=±1，越界回绕 */
export function stepBatch(step: number): void {
  const n = store.batches.length;
  if (n === 0) return;
  store.batchIndex = (store.batchIndex + step + n) % n;
}

export function removeBatch(index: number): void {
  const b = store.batches[index];
  if (!b) return;
  for (const r of b.items) if (r.url) URL.revokeObjectURL(r.url);
  store.batches.splice(index, 1);
  if (store.batchIndex >= store.batches.length) {
    store.batchIndex = Math.max(0, store.batches.length - 1);
  }
}

export function removeTarget(index: number): void {
  const t = store.targets[index];
  if (!t) return;
  URL.revokeObjectURL(t.url);
  store.targets.splice(index, 1);
  log(`移除 ${t.name}`);
}

export function clearTargets(): void {
  for (const t of store.targets) URL.revokeObjectURL(t.url);
  store.targets = [];
}

export function removeCover(index: number): void {
  const c = store.covers[index];
  if (!c) return;
  URL.revokeObjectURL(c.url);
  store.covers.splice(index, 1);
  if (store.targetLayer > store.covers.length) store.targetLayer = store.covers.length;
  log(`移除混淆图 ${c.name}`);
}

export function moveCover(from: number, to: number): void {
  if (from === to || from < 0 || to < 0 || from >= store.covers.length || to >= store.covers.length) return;
  const [c] = store.covers.splice(from, 1);
  store.covers.splice(to, 0, c);
  log(`混淆图 ${c.name} 移至第 ${to + 1} 层`);
}

export function clearCovers(): void {
  for (const c of store.covers) URL.revokeObjectURL(c.url);
  store.covers = [];
  store.targetLayer = 0;
}

export function clearKeyFile(): void {
  if (!store.keyFile) return;
  log(`卸载密钥文件 ${store.keyFile.name}`);
  store.keyFile = null;
}
