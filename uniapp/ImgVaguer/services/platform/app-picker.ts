/**
 * App 端系统文件选择（Android）。
 *
 * 流程：`ACTION_GET_CONTENT`（经「打开方式」）取回文档 → 反解真实路径（core/storage-path）
 * → 用 plus.io 既有通道读字节 → 转存到应用私有目录并返回转存路径。
 * 转存是必需的：后续解密仍按路径回读原始字节。
 *
 * 为什么不做「Native.js 直接搬运字节」（两种写法都实测不通，勿回退）：
 *   · `java.nio` 的 `Files.copy(InputStream, Path)` 在 Native.js 下不可用；
 *   · `InputStream.read(byte[])` 的数组出参不会回填到 JS，读到的恒为 0，
 *     继续写盘只会产出全零文件。
 * 反解路径后改用 plus.io 读取，则完全避开该问题（相册通道长期在用，可靠）。
 *
 * 另外：`ContentResolver` 实例方法不可直接点调用（真机抛 `e.openInputStream is not a function`），
 * 只做授权持久化时须经 `callJava` 反射——见 app-storage。
 */
import { baseNameOf, pathOfDocumentUri } from '@/core/storage-path';
import { newIntent, startForResult, uriToString, withChooser, RESULT_OK } from './app-intent';
import { readFileBytes } from './image-io';
import { requestStoragePermission, writePrivateFile } from './app-storage';

const REQUEST_DOC = 0x1a2b;
const ACTION_GET_CONTENT = 'android.intent.action.GET_CONTENT';
const CATEGORY_OPENABLE = 'android.intent.category.OPENABLE';
/** 选择器默认打开位置（API 26+ 生效，低版本自动忽略） */
const EXTRA_INITIAL_URI = 'android.provider.extra.INITIAL_URI';
/** 失败提示里附带的片段长度（便于定位是哪个 provider / 哪个路径出问题） */
const URI_HINT_LEN = 64;
const PATH_HINT_LEN = 48;

export interface PickedDoc {
  ok: boolean;
  /** 私有目录中的转存路径（可交给 readFileBytes） */
  path: string;
  name: string;
  message: string;
}

/**
 * 打开「打开方式」→ 文件选择器选择单个文档，并转存到应用私有目录。
 * @param mime MIME 过滤（如 application/octet-stream、image/*）
 * @param initialUri 选择器默认打开位置（用户已选的存储文件夹，便于就地取材）
 */
export function pickAppDocument(mime: string, initialUri?: string): Promise<PickedDoc> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: PickedDoc): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const failure = (message: string): void => finish({ ok: false, path: '', name: '', message });

    try {
      const intent = newIntent(ACTION_GET_CONTENT);
      intent.setType(mime);
      intent.addCategory(CATEGORY_OPENABLE);
      if (initialUri) {
        try {
          const Uri = plus.android.importClass('android.net.Uri') as { parse: (s: string) => unknown };
          intent.putExtra(EXTRA_INITIAL_URI, Uri.parse(initialUri));
        } catch {
          // 初始位置仅为便利项，取不到就按系统默认
        }
      }
      startForResult(withChooser(intent, '选择文件'), REQUEST_DOC, (result, data) => {
        if (result !== RESULT_OK || !data) {
          failure('未选择文件');
          return;
        }
        void (async (): Promise<void> => {
          // source 提到 try 之外：失败提示里要用它指明出问题的路径
          let source = '';
          try {
            const uri = uriToString(data.getData());
            source = pathOfDocumentUri(uri);
            if (!source) {
              failure(`该位置无法直接读取，请改选本地存储中的文件（${uri.slice(0, URI_HINT_LEN)}）`);
              return;
            }
            await requestStoragePermission();
            const bytes = await readFileBytes(source);
            if (!bytes.length) throw new Error('所选文件内容为空');
            const name = baseNameOf(source) || 'picked';
            const path = await writePrivateFile(`picked-${Date.now()}-${name.replace(/[^\w.-]/g, '_')}`, bytes);
            finish({ ok: true, path, name, message: '' });
          } catch (e) {
            // 附上源路径尾部：便于判断是权限受限还是路径问题（只留末段，避免提示过长）
            const raw = (e as Error).message || '读取失败';
            const tail = source.length > PATH_HINT_LEN ? `…${source.slice(-PATH_HINT_LEN)}` : source;
            failure(`${raw}（${tail}）`);
          }
        })();
      });
    } catch (e) {
      failure(`无法打开文件选择器：${(e as Error).message}`);
    }
  });
}
