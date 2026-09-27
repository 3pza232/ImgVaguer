export type Mode = 'scramble' | 'overlay';

/** DOM 无关的位图结构，core 层统一使用 */
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA  packed
}

/** 保护方式：无（种子内嵌）/ 口令 / 密钥文件 */
export type Protection = 'none' | 'password' | 'keyfile';

interface BaseParams {
  protection: Protection;
  password: string;
  /** PBKDF2-SHA256 迭代次数 */
  iterations: number;
  /** 多图合并：把本批全部目标图并入一张输出（仅密钥文件保护下生效） */
  pack?: boolean;
}

export interface ScrambleParams extends BaseParams {
  mode: 'scramble';
  blockSize: 8 | 16 | 32;
  /** 可逆加性噪声幅度 0..64 */
  noise: number;
  /** 变换轮数 1..4（专业模式，默认 1） */
  rounds?: number;
  /** 全局像素置换（专业模式，默认 false） */
  globalPerm?: boolean;
  /** 密钥化 S 盒字节替换（专业模式，默认 false） */
  sbox?: boolean;
  /** 行/列循环移位（专业模式，默认 false） */
  rowshift?: boolean;
}

export interface OverlayParams extends BaseParams {
  mode: 'overlay';
  /** 覆盖不透明度 0..1 */
  opacity: number;
  fit: 'cover' | 'stretch';
  /** 目标图所在层：位于其下方的覆盖图数量（默认 0=最底层） */
  targetLayer?: number;
  /** 覆盖层细节压缩 0.1..1，默认 1=不压缩（在服务层应用，引擎不感知） */
  coverQuality?: number;
}

export type ImgVaguerParams = ScrambleParams | OverlayParams;
