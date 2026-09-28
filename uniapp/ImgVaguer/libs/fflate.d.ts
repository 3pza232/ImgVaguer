/**
 * fflate（单文件 ESM 随包分发，见 libs/fflate.js）本地声明：
 * 仅声明本项目实际使用的接口，避免为编辑器引入整包类型依赖。
 */
export declare function zlibSync(data: Uint8Array, opts?: { level?: number }): Uint8Array;
export declare function unzlibSync(data: Uint8Array): Uint8Array;
