/**
 * content:// URI 与文件名的**纯逻辑**反解（无平台依赖，可单测）。
 *
 * 背景：系统选择器返回的是 content:// URI，而逻辑层读它的两条路都不通——
 * `ContentResolver.query` 在 Native.js 下抛 `query is not a function`；
 * `InputStream.read(byte[])` 的数组出参不会回填到 JS（读到的恒为 0）。故改为
 * **从 URI 字符串反解真实文件路径**，之后读写都走已验证的 java.io / plus.io 通道。
 */

/** 路径基名（忽略末尾斜杠） */
export function baseNameOf(path: string): string {
  const parts = path.split('/').filter((s) => !!s);
  return parts.length ? parts[parts.length - 1] : '';
}

/** URI 中指定段落后的文档 ID（已解码；无该段返回空串） */
function docIdOf(uri: string, segment: string): string {
  const encoded = uri.split(segment)[1] ?? '';
  if (!encoded) return '';
  try {
    return decodeURIComponent(encoded);
  } catch {
    // 非标准编码：按原样解析
    return encoded;
  }
}

/**
 * 文档 ID → 真实路径。
 * externalstorage provider 形如 `primary:Download/x.ivkey`、`1A2B-3C4D:foo`，
 * 分别对应 `<primaryRoot>/Download/x.ivkey` 与 `/storage/1A2B-3C4D/foo`；
 * 下载管理器的 `raw:/storage/...` 形式本身就是路径；
 * 其余（云盘、媒体库数字 ID 等）无法映射，返回空串由调用方如实提示。
 */
function pathOfDocId(docId: string, primaryRoot: string): string {
  if (docId.startsWith('raw:')) return docId.slice('raw:'.length);
  const colon = docId.indexOf(':');
  if (colon < 0) return '';
  const volume = docId.slice(0, colon);
  const rest = docId.slice(colon + 1);
  const root = volume === 'primary' ? primaryRoot : `/storage/${volume}`;
  return rest ? `${root}/${rest}` : root;
}

/**
 * SAF 目录 URI（`…/tree/<docId>`）→ 真实路径。
 * primary 卷根目录各机型可能不同，故由调用方向系统取值后传入。
 */
export function pathOfTreeUri(uri: string, primaryRoot = '/storage/emulated/0'): string {
  const docId = docIdOf(uri, '/tree/');
  return docId ? pathOfDocId(docId, primaryRoot) : '';
}

/**
 * SAF 文档 URI（`…/document/<docId>`）→ 真实路径。
 * 用于「从文件夹中选择」：拿到真实路径后即可用 plus.io 既有通道读取，
 * 无需经 Native.js 搬运字节。
 */
export function pathOfDocumentUri(uri: string, primaryRoot = '/storage/emulated/0'): string {
  const docId = docIdOf(uri, '/document/');
  return docId ? pathOfDocId(docId, primaryRoot) : '';
}
