/**
 * 运行时全局对象声明兜底。
 * HBuilderX 工程未引入 @dcloudio/types，此处以轻量声明保持 TS 可用；
 * 平台 API 的具体形态由调用处按需收窄。
 */
declare const uni: any;
declare const wx: any;
declare const plus: any;
