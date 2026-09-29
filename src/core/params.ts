/**
 * 引擎参数装配：把界面上的一组参数收成引擎要的形状。
 *
 * 两端界面各自的 store 字段同名，装配规则也完全一致——哪种方式取哪些旋钮、
 * 哪些带默认值。收进共享层是因为这类规则最容易「改了一边忘另一边」：
 * 少传一个旋钮不会报错，只会在另一端表现成参数不生效。
 */
import type { ImgVaguerParams, Mode, Protection, ScrambleLayout } from './types';

/** 装配所需的全部输入：两端 store 的同名子集，传 store 本身即可 */
export interface ParamsInput {
  protection: Protection;
  password: string;
  iterations: number;
  pack: boolean;
  mode: Mode;
  /** 仅密文混淆使用 */
  layout: ScrambleLayout;
  blockSize: 8 | 16 | 32;
  noise: number;
  rounds: number;
  globalPerm: boolean;
  sbox: boolean;
  rowshift: boolean;
  opacity: number;
  fit: 'cover' | 'stretch';
  targetLayer: number;
  coverQuality: number;
}

export function buildParams(p: ParamsInput): ImgVaguerParams {
  const base = {
    protection: p.protection,
    password: p.password,
    iterations: p.iterations,
    pack: p.pack,
  };
  const scramble = {
    blockSize: p.blockSize,
    noise: p.noise,
    rounds: p.rounds,
    globalPerm: p.globalPerm,
    sbox: p.sbox,
    rowshift: p.rowshift,
  };
  const overlay = {
    opacity: p.opacity,
    fit: p.fit,
    targetLayer: p.targetLayer,
    coverQuality: p.coverQuality,
  };
  if (p.mode === 'overlay') return { ...base, mode: 'overlay', ...overlay };
  if (p.mode === 'hybrid') return { ...base, mode: 'hybrid', ...scramble, ...overlay };
  return { ...base, mode: 'scramble', layout: p.layout, ...scramble };
}
