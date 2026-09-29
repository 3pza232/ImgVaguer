/**
 * 编排层：密钥调度 + 模式分发 + 数据块封装。
 * 与桌面端同源：除平台原语（随机源 / UTF-8 / fflate 打包形态）外逻辑一致。
 *
 * 保护方式（公开字段刻意不可区分）：
 *  - none     随机种子内嵌头部，持图即可还原
 *  - password PBKDF2-SHA256(口令, salt)
 *  - keyfile  HKDF-SHA256(外部 32B 密钥种子, salt)
 * 三者统一为「字节凭据 → 主密钥 → 子密钥」；模式/保护方式等参数加密存放。
 *
 * 载荷与可见像素的分工：
 *  - 载荷级密文混淆、覆盖合成、多图合并：原图以**原始文件字节**加密存入 PNG 私有数据块，
 *    解密即还原原文件（体积与清晰度都与输入一致）；可见像素只作视觉呈现。
 *  - 像素级密文混淆：可见像素即密文，无位图载荷，解密由像素还原为 PNG。
 */
import { ChaCha20, IV_LEN, ivNonce } from '@/core/chacha';
import { decoyRaster } from '@/core/decoy';
import {
  buildChunk,
  buildMeta,
  buildPreamble,
  CHUNK_TYPE,
  EMBEDDED_INFO,
  hasMetaMagic,
  KEYFILE_INFO,
  META_DOMAIN,
  OVERLAY_DOMAIN,
  parseChunk,
  parseMeta,
  SALT_LEN,
  SEED_LEN,
  VERSION,
  type MetaFields,
  type PayloadKind,
} from '@/core/header';
import {
  deriveMasterKey,
  deriveSubKeys,
  hkdfSha256,
  hmacSha256,
  passwordBytes,
  timingSafeEqual,
  type SubKeys,
} from '@/core/kdf';
import { compositeLayers } from '@/core/overlay';
import { packFiles, unpackImages, type DecodedImage, type RawFile } from '@/core/pack';
import {
  decodePngRgba,
  encodePng,
  extractPngChunk,
  LEVEL_COMPRESSED,
  LEVEL_RAW,
  type CompressionLevel,
} from '@/core/png';
import { randomBytes } from '@/core/random';
import { scrambleImage, unscrambleImage, type BlockSize, type ScrambleOptions } from '@/core/scramble';
import { addStages, stageTimesOf, type StageProgress, type StageTimes } from '@/core/stats';
import { utf8Decode, utf8Encode } from '@/core/text';
import type { ImgVaguerParams, Protection, Raster, ScrambleKnobs } from '@/core/types';
import { unzlibSync, zlibSync } from '../libs/fflate.js';

/** 计时基准：Date.now 在桌面、App 与小程序运行时都可用（performance 在 App / 小程序不保证存在） */
function now(): number {
  return Date.now();
}

const BLOCK_SIZES: readonly number[] = [8, 16, 32];
const MIN_ITERATIONS = 1;
const MAX_ITERATIONS = 10_000_000;

export type { DecodedImage };

/**
 * 待加密的原图。
 * 字节与位图都按需获取：多图合并与载荷布局只需要尺寸，
 * 若在选图阶段就为每张图常驻整幅 RGBA，批量大图会直接耗尽内存。
 */
export interface EncryptInput {
  /** 原始文件名，随载荷写入容器，解密时原样还原 */
  name: string;
  /** 原图尺寸 */
  width: number;
  height: number;
  /** 原始文件字节，作为加密载荷 */
  bytes: () => Promise<Uint8Array>;
  /** 按需解码位图：像素级布局与覆盖合成需要真实像素，载荷布局与多图合并不会调用 */
  raster: () => Promise<Raster>;
}

export interface EncryptOutput {
  bytes: Uint8Array;
  outRaster: Raster;
  fields: MetaFields;
  /** 本次加密的分段耗时，供性能分析面板使用 */
  timings: StageTimes;
}

/** 解密结果与分段耗时 */
export interface DecryptOutput {
  images: DecodedImage[];
  timings: StageTimes;
}

/** 详情日志回调：向调用方（终端"详情"视图）输出内部步骤/参数 */
export type Trace = (line: string) => void;

/** 一次加密的密钥调度结果 */
interface Session {
  keys: SubKeys;
  salt: Uint8Array;
  seed: Uint8Array;
  iv: Uint8Array;
  iterations: number;
}

function hex(bytes: Uint8Array, max = 12): string {
  const head = [...bytes.subarray(0, max)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return bytes.length > max ? `${head}…` : head;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Uint8ClampedArray 的字节视图（无拷贝） */
function asBytes(a: Uint8ClampedArray): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

function xorWith(key: Uint8Array, nonce: Uint8Array, data: Uint8Array): void {
  new ChaCha20(key, nonce).xor(data);
}

function validateIterations(iterations: number): void {
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error('非法的迭代次数');
  }
}

/**
 * 派生主密钥。口令走 PBKDF2 抬高枚举成本；全熵凭据（密钥文件种子 / 内嵌种子）
 * 走 HKDF——迭代拉伸对高熵密钥没有强度增益，在纯 TS 实现下更会平白耗费数秒。
 */
function deriveMaster(
  kind: Protection,
  secret: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  if (kind === 'password') return deriveMasterKey(secret, salt, iterations);
  return hkdfSha256(secret, salt, kind === 'keyfile' ? KEYFILE_INFO : EMBEDDED_INFO);
}

/** 按保护方式取出字节凭据 */
function credentialOf(
  protection: Protection,
  password: string,
  extSeed: Uint8Array | undefined,
  seed: Uint8Array,
): Uint8Array {
  if (protection === 'password') return passwordBytes(password);
  if (protection === 'keyfile') {
    if (!extSeed || extSeed.length !== SEED_LEN) throw new Error('缺少密钥种子');
    return extSeed;
  }
  return seed;
}

/** 生成逐图随机 salt/seed/IV 并完成密钥调度 */
async function openSession(
  protection: Protection,
  password: string,
  iterations: number,
  extSeed: Uint8Array | undefined,
  trace?: Trace,
): Promise<Session> {
  const salt = randomBytes(SALT_LEN);
  const seed = randomBytes(SEED_LEN); // none 即主密钥材料，其余为诱饵
  const iv = salt.subarray(0, IV_LEN);
  trace?.(
    `[key] ${protection === 'password' ? `PBKDF2-SHA256 iterations=${iterations}` : 'HKDF-SHA256'} salt=${hex(salt)}`,
  );
  const credential = credentialOf(protection, password, extSeed, seed);
  const keys = await deriveSubKeys(await deriveMaster(protection, credential, salt, iterations));
  trace?.(`[key] IV=${hex(iv)} 子密钥=perm/xor/noise/mac/overlay/meta`);
  return { keys, salt, seed, iv, iterations };
}

/**
 * 原始文件 → 加密载荷：打包为容器 → zlib → 密钥流异或。
 * 原文件本身多为已压缩格式，故压缩耗时可忽略，而 BMP/TIFF 等未压缩格式仍能显著收益。
 * 字节逐个读取，避免与调用方持有的副本同时驻留。
 */
async function sealFiles(sources: EncryptInput[], keys: SubKeys, iv: Uint8Array): Promise<Uint8Array> {
  const files: RawFile[] = [];
  for (const s of sources) files.push({ name: s.name, bytes: await s.bytes() });
  const plain = zlibSync(packFiles(files), { level: LEVEL_COMPRESSED });
  xorWith(keys.overlay, ivNonce(iv, OVERLAY_DOMAIN), plain);
  return plain;
}

/** 加密载荷 → 明文载荷（密钥流异或 → zlib 解压） */
function openPayload(payload: Uint8Array, keys: SubKeys, iv: Uint8Array): Uint8Array {
  const plain = new Uint8Array(payload);
  xorWith(keys.overlay, ivNonce(iv, OVERLAY_DOMAIN), plain);
  return unzlibSync(plain);
}

/**
 * 元数据加密 + HMAC + PNG 封装。
 * MAC 覆盖密文本身，而密文在哪取决于布局：像素级布局的密文是像素，
 * 载荷级布局的密文是加密载荷（可见像素只是装饰，改动它不该影响还原）。
 */
async function seal(
  session: Session,
  raster: Raster,
  payload: Uint8Array,
  fields: MetaFields,
  level: CompressionLevel,
  pixelCipher: boolean,
  trace?: Trace,
): Promise<Uint8Array> {
  const metaCipher = buildMeta(fields, payload);
  trace?.(`[meta] 明文 ${metaCipher.length}B -> ChaCha20 加密`);
  xorWith(session.keys.meta, ivNonce(session.iv, META_DOMAIN), metaCipher);

  const preamble = buildPreamble(VERSION, session.salt, session.iterations, session.seed);
  const cipher = pixelCipher ? asBytes(raster.data) : payload;
  const mac = await hmacSha256(session.keys.mac, concat(preamble, metaCipher, cipher));
  const bytes = encodePng(raster, {
    extra: { type: CHUNK_TYPE, data: buildChunk(preamble, metaCipher, mac) },
    level,
  });
  trace?.(`[mac] HMAC-SHA256 over preamble||meta||${pixelCipher ? `pixel(${cipher.length}B)` : `payload(${cipher.length}B)`}`);
  trace?.(`[out] ${raster.width}x${raster.height} PNG ${(bytes.length / 1024).toFixed(1)}KB chunk=${preamble.length + metaCipher.length + mac.length}B`);
  return bytes;
}

/**
 * 校验 MAC，按覆盖范围依次尝试：新文件覆盖加密载荷，历史文件覆盖像素。
 * 两个范围都含 preamble 与 metaCipher，故未持密钥者无法伪造任一范围；
 * 先试载荷范围（通常只有几 MB）也让历史文件只多花一次廉价比对。
 */
async function verifyMac(key: Uint8Array, data: Uint8Array, expect: Uint8Array): Promise<boolean> {
  return timingSafeEqual(await hmacSha256(key, data), expect);
}

function scrambleOptions(p: ScrambleKnobs): ScrambleOptions {
  return {
    rounds: p.rounds ?? 1,
    globalPerm: p.globalPerm ?? false,
    sbox: p.sbox ?? false,
    rowshift: p.rowshift ?? false,
  };
}

/** 像素布局的载荷：仅记录专业参数，全部默认时留空 */
function scrambleParams(o: ScrambleOptions): Uint8Array {
  if (o.rounds === 1 && !o.globalPerm && !o.sbox && !o.rowshift) return new Uint8Array(0);
  return utf8Encode(JSON.stringify({
    r: o.rounds,
    g: o.globalPerm ? 1 : 0,
    s: o.sbox ? 1 : 0,
    rs: o.rowshift ? 1 : 0,
  }));
}

function parseScrambleOpts(payload: Uint8Array): ScrambleOptions {
  if (payload.length === 0) return {};
  try {
    const j = JSON.parse(utf8Decode(payload)) as { r?: number; g?: number; s?: number; rs?: number };
    return {
      rounds: j.r ?? 1,
      globalPerm: j.g === 1,
      sbox: j.s === 1,
      rowshift: j.rs === 1,
    };
  } catch {
    // HMAC 已保证完整性，正常不会到此
    return {};
  }
}

/** 一次加密的可见像素与载荷组装结果 */
interface Assembled {
  outRaster: Raster;
  payload: Uint8Array;
  payloadKind: PayloadKind;
  level: CompressionLevel;
  p1: number;
  p2: number;
  /** 可见像素即密文（像素级布局），决定 MAC 覆盖像素还是载荷 */
  pixelCipher: boolean;
  /** 载荷与像素两段耗时；密钥派生与输出封装由调用方补齐 */
  timings: StageTimes;
}

/**
 * 组装可见像素与载荷。
 * 除「像素级密文混淆」外，载荷一律为原始文件字节，可见像素只作视觉呈现。
 */
async function assemble(
  sources: EncryptInput[],
  params: ImgVaguerParams,
  covers: Raster[],
  session: Session,
  pack: boolean,
  trace?: Trace,
  progress?: StageProgress,
): Promise<Assembled> {
  const { width, height } = sources[0];
  progress?.('payload');
  const tPayload = now();
  const payload = await sealFiles(sources, session.keys, session.iv);
  const common = {
    payload,
    payloadKind: 'file' as PayloadKind,
    level: LEVEL_COMPRESSED,
    p1: 0,
    p2: 0,
    pixelCipher: false,
    timings: stageTimesOf({ payload: now() - tPayload }),
  };
  const label = pack ? `合并 ${sources.length} 张` : '单图';

  if (params.mode === 'scramble') {
    const o = scrambleOptions(params);
    const p1 = params.blockSize;
    const p2 = params.noise;
    if (params.layout === 'payload') {
      progress?.('pixels');
      const t = now();
      const outRaster = decoyRaster(width, height, common.payload.length, session.keys.noise, session.iv);
      trace?.(`[cipher] ${label} 可见图=装饰噪声 ${outRaster.width}x${outRaster.height} 载荷=原始文件`);
      return { ...common, p1, p2, outRaster, timings: { ...common.timings, pixels: now() - t } };
    }
    trace?.(`[cipher] ${label} 可见图=像素密文 x${o.rounds} @block${params.blockSize}`);
    progress?.('pixels');
    const t = now();
    const visible = scrambleImage(await sources[0].raster(), session.keys, params.blockSize, params.noise, session.iv, o);
    const pixels = now() - t;
    if (pack) return { ...common, p1, p2, outRaster: visible, pixelCipher: true, timings: { ...common.timings, pixels } };
    // 单图：可见像素即密文，无位图载荷，仅记录专业参数
    return {
      outRaster: visible,
      payload: scrambleParams(o),
      payloadKind: 'mode',
      level: LEVEL_RAW,
      p1,
      p2,
      pixelCipher: true,
      timings: { ...common.timings, pixels },
    };
  }

  // 覆盖合成与混合方式都需要覆盖图层
  if (!covers.length) throw new Error('需要至少一张覆盖图');
  for (const c of covers) {
    if (c.width !== width || c.height !== height) {
      throw new Error(pack ? '覆盖图尺寸需与首图一致' : '覆盖图尺寸需与目标一致');
    }
  }

  progress?.('pixels');
  const t = now();
  const target = await sources[0].raster();
  // 混合方式先做像素级密文混淆，再把覆盖层叠上去：覆盖层是门面，底下的像素已是噪声
  const base = params.mode === 'hybrid' ? scrambleImage(target, session.keys, params.blockSize, params.noise, session.iv, scrambleOptions(params)) : target;
  const visible = compositeLayers(base, covers, params.opacity, params.targetLayer ?? 0);
  const pixels = now() - t;
  trace?.(
    `[cipher] ${label} 可见图=${params.mode === 'hybrid' ? `密文底图+覆盖 @block${params.blockSize}` : '覆盖合成'} layers=${covers.length} opacity=${params.opacity}`,
  );
  return {
    ...common,
    outRaster: visible,
    p1: Math.round(params.opacity * 100),
    p2: params.fit === 'cover' ? 0 : 1,
    timings: { ...common.timings, pixels },
  };
}

/** 加密收尾：写入元数据标志并封装 */
async function finish(
  session: Session,
  assembled: Assembled,
  params: ImgVaguerParams,
  pack: boolean,
  origin: { width: number; height: number },
  trace?: Trace,
): Promise<EncryptOutput> {
  const fields: MetaFields = {
    mode: params.mode,
    pack,
    protection: params.protection,
    payloadKind: assembled.payloadKind,
    pixelCipher: assembled.pixelCipher,
    p1: assembled.p1,
    p2: assembled.p2,
    origWidth: origin.width,
    origHeight: origin.height,
  };
  const bytes = await seal(session, assembled.outRaster, assembled.payload, fields, assembled.level, assembled.pixelCipher, trace);
  return { bytes, outRaster: assembled.outRaster, fields, timings: assembled.timings };
}

/**
 * 单图加密。
 * @param covers 覆盖图层（已缩放至目标尺寸），按叠放顺序排列
 * @param extSeed keyfile 模式下由调用方生成的 32B 密钥种子
 */
export async function encryptImage(
  source: EncryptInput,
  params: ImgVaguerParams,
  covers: Raster[] = [],
  extSeed?: Uint8Array,
  trace?: Trace,
  progress?: StageProgress,
): Promise<EncryptOutput> {
  validateIterations(params.iterations);
  progress?.('kdf');
  const tKdf = now();
  const session = await openSession(params.protection, params.password, params.iterations, extSeed, trace);
  const kdf = now() - tKdf;
  const assembled = await assemble([source], params, covers, session, false, trace, progress);
  progress?.('output');
  const tOut = now();
  const out = await finish(session, assembled, params, false, source, trace);
  return withTimings(out, kdf, now() - tOut);
}

/** 补齐密钥派生与输出封装两段耗时（这两段发生在 assemble 之外） */
function withTimings(out: EncryptOutput, kdf: number, output: number): EncryptOutput {
  return { ...out, timings: addStages(out.timings, stageTimesOf({ kdf, output })) };
}

/**
 * 多图合并加密（三种保护方式均可用）。
 * 整批原图装入加密载荷，输出单张图；解密端凭 pack 标志自动展开为全部原文件。
 * 可见图：像素布局取「首图打乱」，载荷布局取块状噪声装饰图。
 */
export async function encryptPack(
  sources: EncryptInput[],
  params: ImgVaguerParams,
  covers: Raster[] = [],
  extSeed?: Uint8Array,
  trace?: Trace,
  progress?: StageProgress,
): Promise<EncryptOutput> {
  if (!sources.length) throw new Error('需要至少一张目标图');
  validateIterations(params.iterations);
  progress?.('kdf');
  const tKdf = now();
  const session = await openSession(params.protection, params.password, params.iterations, extSeed, trace);
  const kdf = now() - tKdf;
  trace?.(`[pack] ${sources.map((s) => s.name).join(', ')}`);
  const assembled = await assemble(sources, params, covers, session, true, trace, progress);
  progress?.('output');
  const tOut = now();
  const out = await finish(session, assembled, params, true, sources[0], trace);
  return withTimings(out, kdf, now() - tOut);
}

/** 轻量探测：是否含有本工具数据块及其格式版本（不泄露任何加密内容） */
export function readHeader(bytes: Uint8Array): { version: number } | null {
  const chunk = extractPngChunk(bytes, CHUNK_TYPE);
  if (!chunk || chunk.length < 1) return null;
  return { version: chunk[0] };
}

/**
 * 解密。像素从 PNG 内部无损解出，调用方无需预解码。
 * 依次尝试「密钥文件 / 口令 / 内嵌种子」三种凭据，由内部魔数判定成功者。
 * 载荷为原始文件字节时返回原文件；多图合并返回全部原文件。
 * 结果连同分段耗时一起返回，供性能分析面板使用。
 */
export async function decryptImages(
  bytes: Uint8Array,
  password?: string,
  keySeed?: Uint8Array,
  trace?: Trace,
  progress?: StageProgress,
): Promise<DecryptOutput> {
  const chunk = extractPngChunk(bytes, CHUNK_TYPE);
  if (!chunk) throw new Error('未找到 ImgVaguer 数据块，非本工具生成');
  const c = parseChunk(chunk);
  if (c.version !== VERSION) throw new Error(`不支持的版本: ${c.version}（本版格式为 v${VERSION}，请用最新版重新加密）`);
  validateIterations(c.iterations);
  trace?.(`[in] 数据块 v${c.version} salt=${hex(c.salt)} iterations=${c.iterations}`);

  const iv = c.salt.subarray(0, IV_LEN);
  // 像素按需解码：载荷级布局的明文全在载荷里，整幅解码只是白等
  let raster: Raster | null = null;
  let pixelsMs = 0;
  const pixels = (): Raster => {
    if (!raster) {
      progress?.('pixels');
      const t = now();
      raster = decodePngRgba(bytes);
      pixelsMs += now() - t;
      trace?.(`[in] 像素无损解码 ${raster.width}x${raster.height}`);
    }
    return raster;
  };

  const labeled: { kind: Protection; secret: Uint8Array }[] = [];
  if (keySeed) labeled.push({ kind: 'keyfile', secret: keySeed });
  if (password) labeled.push({ kind: 'password', secret: passwordBytes(password) });
  labeled.push({ kind: 'none', secret: c.seed });
  trace?.(`[try] 候选凭据: ${labeled.map((l) => l.kind).join(' / ')}`);

  let keys: SubKeys | null = null;
  let meta: Uint8Array | null = null;
  progress?.('kdf');
  const tKdf = now();
  for (const { kind, secret } of labeled) {
    const master = await deriveMaster(kind, secret, c.salt, c.iterations);
    const k = await deriveSubKeys(master);
    const plain = new Uint8Array(c.metaCipher);
    xorWith(k.meta, ivNonce(iv, META_DOMAIN), plain);
    trace?.(`[try] ${kind}: 元数据魔数${hasMetaMagic(plain) ? ' 命中' : '不符'}`);
    if (hasMetaMagic(plain)) {
      keys = k;
      meta = plain;
      break;
    }
  }
  const kdfMs = now() - tKdf;
  if (!keys || !meta) {
    throw new Error(
      password || keySeed
        ? '口令/密钥错误或数据已损坏'
        : '该图像受口令或密钥文件保护，请提供对应凭据',
    );
  }

  const { fields, payload } = parseMeta(meta);
  trace?.(`[meta] 模式=${fields.mode}${fields.pack ? '+合并' : ''} 载荷=${fields.payloadKind} 原尺寸=${fields.origWidth}x${fields.origHeight}`);

  // MAC 覆盖真正承载密文的一侧，由元数据标志确定范围（无需试探、不读多余的像素）
  const cipher = fields.pixelCipher ? asBytes(pixels().data) : payload;
  if (!(await verifyMac(keys.mac, concat(c.preamble, c.metaCipher, cipher), c.mac))) {
    throw new Error('数据已损坏');
  }
  trace?.(`[mac] HMAC-SHA256 校验通过（${fields.pixelCipher ? '像素密文' : '加密载荷'}）`);

  // 位图载荷：单图、多图合并、覆盖合成、混合方式的载荷都是原始文件字节（单图即 count = 1）
  if (fields.payloadKind === 'file') {
    progress?.('payload');
    const t = now();
    const files = unpackImages(openPayload(payload, keys, iv));
    const payloadMs = now() - t;
    trace?.(`[payload] 还原原始文件 ${files.length} 项`);
    return { images: files, timings: stageTimesOf({ kdf: kdfMs, payload: payloadMs, pixels: pixelsMs }) };
  }

  // 像素级布局：可见像素即密文，载荷只带专业参数
  if (!BLOCK_SIZES.includes(fields.p1)) throw new Error('非法的分块尺寸');
  const t = now();
  const restored = unscrambleImage(pixels(), keys, fields.p1 as BlockSize, fields.p2, iv, parseScrambleOpts(payload));
  pixelsMs += now() - t;
  return {
    images: [{ name: '', raster: restored }],
    timings: stageTimesOf({ kdf: kdfMs, payload: 0, pixels: pixelsMs }),
  };
}

/**
 * 便捷封装：只关心还原结果时用这个。
 * 需要分段耗时（性能分析）时调用 decryptImages。
 */
export async function decryptImage(
  bytes: Uint8Array,
  password?: string,
  keySeed?: Uint8Array,
  trace?: Trace,
): Promise<DecodedImage[]> {
  return (await decryptImages(bytes, password, keySeed, trace)).images;
}
