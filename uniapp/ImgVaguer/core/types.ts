export type Mode = 'scramble' | 'overlay' | 'hybrid';

/** DOM 无关的位图结构，core 层统一使用 */
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA  packed
}

/** 保护方式：无（种子内嵌）/ 口令 / 密钥文件 */
export type Protection = 'none' | 'password' | 'keyfile';

/**
 * 密文混淆的可见像素布局：
 * - `pixel`   可见像素即密文，全图逐像素可逆变换，无独立载荷
 * - `payload` 可见像素为噪声装饰，原图经滤波压缩后存入加密载荷（体积约为前者的 1/2）
 */
export type ScrambleLayout = 'pixel' | 'payload';

interface BaseParams {
  protection: Protection;
  password: string;
  /** PBKDF2-SHA256 迭代次数（仅口令凭据使用） */
  iterations: number;
  /** 多图合并：把本批全部目标图并入一张输出 */
  pack?: boolean;
}

/** 像素级密文变换的可调旋钮：密文混淆与混合方式共用 */
export interface ScrambleKnobs {
  blockSize: 8 | 16 | 32;
  /** 可逆加性噪声幅度 0..64 */
  noise: number;
  /** 变换轮数 1..MAX_ROUNDS（专业模式，默认 1） */
  rounds?: number;
  /** 全局像素置换（专业模式，默认 false） */
  globalPerm?: boolean;
  /** 密钥化 S 盒字节替换（专业模式，默认 false） */
  sbox?: boolean;
  /** 行/列循环移位（专业模式，默认 false） */
  rowshift?: boolean;
}

/** 覆盖合成的可调旋钮：覆盖合成与混合方式共用 */
export interface OverlayKnobs {
  /** 覆盖不透明度 0..1 */
  opacity: number;
  fit: 'cover' | 'stretch';
  /** 目标图所在层：位于其下方的覆盖图数量（默认 0=最底层） */
  targetLayer?: number;
  /** 覆盖层细节压缩 0.1..1，默认 1=不压缩（在服务层应用，引擎不感知） */
  coverQuality?: number;
}

export interface ScrambleParams extends BaseParams, ScrambleKnobs {
  mode: 'scramble';
  layout: ScrambleLayout;
}

export interface OverlayParams extends BaseParams, OverlayKnobs {
  mode: 'overlay';
}

/**
 * 混合方式：先对目标图做像素级密文混淆，再叠加覆盖图层。
 * 可见结果是「密文底图 + 覆盖层」：覆盖层是第一眼看到的内容，
 * 即便被褪除或调成半透明，露出的也是密文噪声而非原图。
 * 原图仍以原始文件字节存入加密载荷，还原不依赖可见像素，故依然逐位无损。
 */
export interface HybridParams extends BaseParams, ScrambleKnobs, OverlayKnobs {
  mode: 'hybrid';
}

export type ImgVaguerParams = ScrambleParams | OverlayParams | HybridParams;
