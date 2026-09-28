/** 轻量响应式会话状态 + uni 存储持久化（结构对齐桌面版，去掉 DOM 专属字段） */
import type { Mode, Protection, Raster, ScrambleLayout } from '@/core/types';
// 仅类型引用（编译期擦除）：设置中的导出目录由平台层定义
import type { ExportTree } from '@/services/platform/app-storage';
import { getItem, setItem } from '@/services/platform/storage';
import { reactive, watch } from 'vue';

/**
 * 已选图像。位图不常驻：载荷布局与多图合并只需尺寸，
 * 必须像素时才（像素级布局 / 覆盖合成）按 path 解码，避免批量大图耗尽内存。
 * path 同时是显示源：列表、堆叠预览与放大都用它，不再为预览单独解码编码一遍。
 */
interface PickedImage {
  name: string;
  /** 解码与读取来源，同时作为预览源：选图路径，或默认混淆图的 data URL */
  path: string;
  width: number;
  height: number;
}

export type TargetItem = PickedImage;

/** 混淆图层：持位图缓存，批量加密时同一层不会重复解码 */
export interface CoverItem extends PickedImage {
  raster?: Raster;
}

/** 一次加密批次共用的密钥文件（供结果随时导出） */
export interface KeyFileRef {
  name: string;
  text: string;
}

export interface ResultItem {
  name: string;
  bytes: Uint8Array | null;
  preview: string;
  ok: boolean;
  error?: string;
}

export interface ResultBatch {
  items: ResultItem[];
  keyFile: KeyFileRef | null;
}

export type LogLevel = 'info' | 'detail';

/** 进行中的任务：既作"忙"标志，也决定底部按钮文案 */
export type BusyTask = 'encrypt' | 'decrypt' | 'export';

export interface LogLine {
  time: string;
  level: LogLevel;
  text: string;
}

export interface SavedParams {
  protection: Protection;
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
  rememberParams: boolean;
  defaultPassword: string;
  defaultCover: { name: string; dataUrl: string } | null;
  /** 默认混淆图大小上限（MB） */
  defaultCoverMaxMB: number;
  /** 混淆图层数量上限 */
  maxCoverLayers: number;
  /** 单批目标图数量上限 */
  maxTargets: number;
  /** 单张图像像素上限 */
  maxPixels: number;
  /** 导出存储位置（App：用户在系统文件管理器中自选的目录；null 表示未选择，首次导出时引导） */
  exportTree: ExportTree | null;
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

/** 合并张数上限区间：上限 4 控制手机上的体积与内存 */
export const TARGET_MIN = 1;
export const TARGET_MAX = 4;
/** 混淆图层数上限区间 */
export const COVER_MIN = 1;
export const COVER_MAX = 3;

/** 收敛到可选区间（旧版本可能留下越界值） */
export function clampTargets(n: number): number {
  return Math.min(Math.max(Math.round(n), TARGET_MIN), TARGET_MAX);
}

/** 同上，用于混淆图层数 */
export function clampCovers(n: number): number {
  return Math.min(Math.max(Math.round(n), COVER_MIN), COVER_MAX);
}

function loadSettings(): Settings {
  const fallback: Settings = {
    rememberParams: true,
    defaultPassword: '',
    defaultCover: null,
    defaultCoverMaxMB: 1.5,
    maxCoverLayers: 3,
    maxTargets: 4,
    maxPixels: 20_000_000,
    exportTree: null,
    params: { ...defaultParams },
  };
  try {
    const raw = getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      rememberParams: s.rememberParams ?? true,
      defaultPassword: s.defaultPassword ?? '',
      defaultCover: s.defaultCover ?? null,
      defaultCoverMaxMB: s.defaultCoverMaxMB ?? 1.5,
      maxCoverLayers: clampCovers(s.maxCoverLayers ?? 3),
      maxTargets: clampTargets(s.maxTargets ?? 4),
      maxPixels: s.maxPixels ?? 20_000_000,
      exportTree: s.exportTree ?? null,
      params: { ...defaultParams, ...(s.params ?? {}) },
    };
  } catch {
    return fallback;
  }
}

export const settings = reactive<Settings>(loadSettings());

export const store = reactive({
  op: 'encrypt' as 'encrypt' | 'decrypt',
  mode: 'scramble' as Mode,
  protection: 'password' as Protection,
  pack: false,
  password: '',
  layout: 'payload' as ScrambleLayout,
  iterations: 200000,
  blockSize: 16 as 8 | 16 | 32,
  noise: 16,
  opacity: 1,
  fit: 'cover' as 'cover' | 'stretch',
  coverQuality: 1,
  rounds: 2,
  globalPerm: true,
  sbox: true,
  rowshift: true,

  targets: [] as TargetItem[],
  /** 混淆图层，按下层→上层排列 */
  covers: [] as CoverItem[],
  /** 目标图所在层：位于其下方的混淆图数量 */
  targetLayer: 0,
  /** 解密用密钥（载入的文件或粘贴的文本） */
  keyFile: null as { name: string; seed: Uint8Array } | null,

  batches: [] as ResultBatch[],
  batchIndex: 0,
  logs: [] as LogLine[],
  logView: 'brief' as 'brief' | 'detail',
  busy: null as BusyTask | null,
});

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

/** 口令模式下输入框为空时，自动填入设置中的默认口令 */
export function applyDefaultPassword(): void {
  if (store.protection === 'password' && !store.password && settings.defaultPassword) {
    store.password = settings.defaultPassword;
  }
}

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
  setItem(SETTINGS_KEY, JSON.stringify(settings));
}

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

/** 详情日志：加密/解密内部的步骤、参数与方法 */
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
  if (!store.batches[index]) return;
  store.batches.splice(index, 1);
  if (store.batchIndex >= store.batches.length) {
    store.batchIndex = Math.max(0, store.batches.length - 1);
  }
}

export function removeTarget(index: number): void {
  const t = store.targets[index];
  if (!t) return;
  store.targets.splice(index, 1);
  log(`移除 ${t.name}`);
}

export function clearTargets(): void {
  store.targets = [];
}

export function removeCover(index: number): void {
  const c = store.covers[index];
  if (!c) return;
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
  store.covers = [];
  store.targetLayer = 0;
}

export function clearKeyFile(): void {
  if (!store.keyFile) return;
  log(`卸载密钥 ${store.keyFile.name}`);
  store.keyFile = null;
}
