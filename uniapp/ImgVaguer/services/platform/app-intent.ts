/**
 * App 端 Activity / Intent 基础封装（Android，Native.js）。
 *
 * 多个选择器共存时若各自覆盖 `onActivityResult` 会互相顶掉，
 * 故此处集中接管并按请求码分发，同时保留并转发原有回调（不影响框架自身处理）。
 * 另统一用「打开方式」选择器包裹 Intent，把由哪个应用处理交给用户决定。
 */
export const RESULT_OK = -1;

/** Intent 授权标志位（Android 常量字面值：READ=1、WRITE=2、PERSISTABLE=0x40） */
export const FLAG_GRANT_READ = 0x1;
export const FLAG_GRANT_WRITE = 0x2;
export const FLAG_GRANT_PERSISTABLE = 0x40;

/** 系统选择器返回的 Intent 数据（仅取用到的成员） */
export interface IntentData {
  getData: () => unknown;
  /** 部分场景可取得授权标志位 */
  getFlags?: () => number;
}

export interface AndroidIntent {
  addFlags: (flags: number) => void;
  addCategory: (category: string) => void;
  setType: (type: string) => void;
  putExtra: (name: string, value: unknown) => void;
}

/**
 * 仅声明用到的 ContentResolver 成员：只做目录授权持久化。
 * 不声明也不使用 query / openInputStream / openOutputStream——这些重载在 Native.js 下
 * 要么不可调用、要么数组出参不回填，故读写一律走「反解真实路径 + java.io / plus.io」。
 */
export interface ContentResolver {
  takePersistableUriPermission: (uri: unknown, flags: number) => void;
}

export interface AndroidActivity {
  startActivityForResult: (intent: unknown, code: number) => void;
  onActivityResult: ((code: number, result: number, data: IntentData | null) => void) | null;
  getContentResolver: () => ContentResolver;
}

export function activity(): AndroidActivity {
  return plus.android.runtimeMainActivity() as AndroidActivity;
}

/**
 * JS 字节 → Java byte[]。
 * Java 的 byte 为有符号，故 >127 的值需换算为负值，否则会被桥接层截断出错。
 */
export function toJavaBytes(bytes: Uint8Array): number[] {
  const out: number[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] > 127 ? bytes[i] - 256 : bytes[i];
  return out;
}

/**
 * 调用 Java 实例方法（反射）。
 *
 * Native.js 只为「已 importClass 的类」的实例暴露方法名：`new FileOutputStream(...)` 这类
 * 因类已导入而可直接调用；而手工取回的实例（如 `getContentResolver()` 的返回值）其方法名
 * 在 JS 侧并不存在，直接写 `res.openInputStream(uri)` 会抛 `openInputStream is not a function`
 * （打包后变量名被压缩，日志里表现为 `e.openInputStream is not a function`）。
 * 故此类调用一律经 `plus.android.invoke`，不依赖类导入顺序。
 */
export function callJava<T = unknown>(target: unknown, method: string, ...args: unknown[]): T {
  return plus.android.invoke(target, method, ...args) as T;
}

export function contentResolver(): ContentResolver {
  return activity().getContentResolver();
}

/** 构造 Intent（动作与类别用字面量，避免 Native.js 静态字段取值差异） */
export function newIntent(action: string): AndroidIntent {
  const Intent = plus.android.importClass('android.content.Intent') as new (action: string) => AndroidIntent;
  return new Intent(action);
}

/** 包裹「打开方式」选择器：让用户自行决定由哪个应用处理该 Intent */
export function withChooser(intent: unknown, title: string): unknown {
  const Intent = plus.android.importClass('android.content.Intent') as {
    createChooser: (target: unknown, title: string) => unknown;
  };
  return Intent.createChooser(intent, title);
}

/** Java Uri → 字符串（JS 直接转换会得到 [object Object]） */
export function uriToString(uri: unknown): string {
  return String(plus.android.invoke(uri, 'toString'));
}

const handlers = new Map<number, (result: number, data: IntentData | null) => void>();
let installed = false;

/** 启动 Activity 并等待结果；回调按请求码分发，其余请求码继续交给原回调 */
export function startForResult(
  intent: unknown,
  code: number,
  handler: (result: number, data: IntentData | null) => void,
): void {
  const main = activity();
  handlers.set(code, handler);
  if (!installed) {
    installed = true;
    const previous = main.onActivityResult;
    main.onActivityResult = (c, r, d): void => {
      const own = handlers.get(c);
      if (own) {
        handlers.delete(c);
        own(r, d);
        return;
      }
      if (typeof previous === 'function') previous(c, r, d);
    };
  }
  main.startActivityForResult(intent, code);
}
