/**
 * App 端存储（Android）：导出文件夹选取与字节落盘。
 *
 * 导出位置由用户在系统「打开方式」里自选（SAF：`ACTION_OPEN_DOCUMENT_TREE`），授权持久化后长期可用：
 * 可选下载/文档/自建目录/外置卡等任意用户可见位置，不受分区存储对固定路径的限制。
 *
 * 关键取舍：URI 取回后**立即反解为真实文件路径**（见 core/storage-path），读写都走
 * `java.io.FileOutputStream` / plus.io 这两条已在真机验证可靠的通道；全程不使用
 * `ContentResolver.query` / `DocumentsContract` / `openOutputStream`（Native.js 下桥接不可靠）。
 */
import { baseNameOf, pathOfTreeUri } from '@/core/storage-path';
import {
  activity,
  callJava,
  contentResolver,
  newIntent,
  startForResult,
  toJavaBytes,
  uriToString,
  withChooser,
  FLAG_GRANT_PERSISTABLE,
  FLAG_GRANT_READ,
  FLAG_GRANT_WRITE,
  RESULT_OK,
} from './app-intent';

const REQUEST_DIR = 0x2b1c;
const ACTION_OPEN_DOCUMENT_TREE = 'android.intent.action.OPEN_DOCUMENT_TREE';

/** 用户选定的导出文件夹 */
export interface ExportTree {
  /** SAF 目录 URI（持久授权，可用于把系统选择器默认打开到该目录） */
  uri: string;
  /** 反解出的真实路径（写入用） */
  path: string;
  /** 展示用文件夹名 */
  name: string;
}

export interface PickedDir {
  ok: boolean;
  tree: ExportTree | null;
  message: string;
}

export interface WrittenFile {
  ok: boolean;
  /** 完整文件路径（进度与日志用） */
  path: string;
  message: string;
  /** 尚未选择存储位置：由界面引导用户选择后重试 */
  needDir?: boolean;
}

type JavaFile = {
  exists: () => boolean;
  mkdirs: () => boolean;
  length: () => number;
  getAbsolutePath: () => string;
};
type JavaOut = { write: (data: number[]) => void; flush: () => void; close: () => void };
type FileEntryLike = { toLocalURL: () => string };
type DirEntry = {
  getFile: (name: string, options: { create: boolean }, ok: (entry: FileEntryLike) => void, err: () => void) => void;
};

/** 外部存储 primary 卷根目录（各机型挂载点可能不同，故向系统取值） */
function primaryRoot(): string {
  try {
    const Environment = plus.android.importClass('android.os.Environment') as {
      getExternalStorageDirectory: () => unknown;
    };
    // 先导入 File 类：Native.js 只对已导入类的实例暴露方法名
    plus.android.importClass('java.io.File');
    return String(callJava(Environment.getExternalStorageDirectory(), 'getAbsolutePath'));
  } catch {
    return '/storage/emulated/0';
  }
}

/** 申请外部存储读写（Android 10 及以下需要；被拒绝时由后续读写结果如实反馈） */
export function requestStoragePermission(): Promise<void> {
  return new Promise((resolve) => {
    try {
      plus.android.requestPermissions(
        ['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE'],
        () => resolve(),
        () => resolve(),
      );
    } catch {
      resolve();
    }
  });
}

/** 图片写入后通知相册索引（失败不影响导出结果） */
function scanMedia(path: string, mime: string): void {
  if (!mime.startsWith('image/')) return;
  try {
    const MediaScannerConnection = plus.android.importClass('android.media.MediaScannerConnection') as {
      scanFile: (ctx: unknown, paths: string[], mimes: string[], cb: unknown) => void;
    };
    MediaScannerConnection.scanFile(activity(), [path], [mime], null);
  } catch {
    // 忽略：相册未及时索引不影响文件本身
  }
}

/** 写字节到指定文件路径并核对落盘长度（不多写、不少写） */
export function writeBytesToPath(path: string, bytes: Uint8Array): void {
  const FileOutputStream = plus.android.importClass('java.io.FileOutputStream') as new (p: string) => JavaOut;
  const out = new FileOutputStream(path);
  try {
    out.write(toJavaBytes(bytes));
    out.flush();
  } finally {
    out.close();
  }
  const FileOfPath = plus.android.importClass('java.io.File') as new (p: string) => JavaFile;
  const size = new FileOfPath(path).length();
  if (size !== bytes.length) throw new Error(`写入不完整（${size}/${bytes.length} 字节）`);
}

/**
 * 取应用私有目录（`_doc`）下某文件的绝对路径。
 * 路径必须由 plus.io 给出：自行用 `convertLocalFileSystemURL('_doc/') + 文件名` 拼接
 * 会落到进程工作目录，表现为写入"成功"但读取报「文件不存在」。
 */
function privateDocPath(name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    plus.io.requestFileSystem(
      plus.io.PRIVATE_DOC,
      (fs: { root: DirEntry }) => {
        fs.root.getFile(
          name,
          { create: true },
          (entry) => resolve(entry.toLocalURL().replace(/^file:\/\//, '')),
          () => reject(new Error('创建临时文件失败')),
        );
      },
      () => reject(new Error('应用私有目录不可用')),
    );
  });
}

/** 写字节到应用私有目录，返回其绝对路径（「从文件夹选择」转存用） */
export async function writePrivateFile(name: string, bytes: Uint8Array): Promise<string> {
  const path = await privateDocPath(name);
  writeBytesToPath(path, bytes);
  return path;
}

/** 打开「打开方式」→ 文件夹选择器，取回并持久化目录授权，同时反解真实路径 */
export function pickAppDirectory(): Promise<PickedDir> {
  return new Promise((resolve) => {
    try {
      const intent = newIntent(ACTION_OPEN_DOCUMENT_TREE);
      intent.addFlags(FLAG_GRANT_READ | FLAG_GRANT_WRITE | FLAG_GRANT_PERSISTABLE);
      startForResult(withChooser(intent, '选择导出文件夹'), REQUEST_DIR, (result, data) => {
        if (result !== RESULT_OK || !data) {
          resolve({ ok: false, tree: null, message: '未选择文件夹' });
          return;
        }
        const uri = uriToString(data.getData());
        const root = primaryRoot();
        const path = pathOfTreeUri(uri, root);
        if (!path) {
          resolve({
            ok: false,
            tree: null,
            message: '该位置不支持直接写入，请改选「下载」或自建的本地文件夹',
          });
          return;
        }
        // 持久化授权：失败仅影响「重启后免重选」，本次仍可用，故单独吞掉
        try {
          const allowed = FLAG_GRANT_READ | FLAG_GRANT_WRITE;
          const granted = (callJava<number>(data, 'getFlags') || 0) & allowed;
          callJava(contentResolver(), 'takePersistableUriPermission', data.getData(), granted || allowed);
        } catch {
          // 忽略
        }
        // 卷根目录取不到有意义的基名，给个可读称呼
        const name = path === root ? '内部存储' : baseNameOf(path) || '已选文件夹';
        resolve({ ok: true, tree: { uri, path, name }, message: '' });
      });
    } catch (e) {
      resolve({ ok: false, tree: null, message: `无法打开文件夹选择器：${(e as Error).message}` });
    }
  });
}

/**
 * 写入字节到指定文件夹（覆盖同名文件）。
 * 成功判据：写入不抛错且落盘尺寸与入参一致——导出的是本工具加密结果，字节必须精确。
 */
export async function writeBytesToDir(
  dir: string,
  name: string,
  bytes: Uint8Array,
  mime: string,
): Promise<WrittenFile> {
  const target = `${dir}/${name}`;
  if (!dir) return { ok: false, path: target, message: '尚未选择存储位置', needDir: true };
  try {
    await requestStoragePermission();
    // 同一个类按两种构造签名分别建模（TS 无法为一个值声明重载构造）
    const FileOfPath = plus.android.importClass('java.io.File') as new (path: string) => JavaFile;
    const FileInDir = plus.android.importClass('java.io.File') as new (parent: JavaFile, child: string) => JavaFile;

    const folder = new FileOfPath(dir);
    if (!folder.exists() && !folder.mkdirs()) {
      return { ok: false, path: target, message: '文件夹不可用，请在设置中重新选择存储位置', needDir: true };
    }
    const file = new FileInDir(folder, name);
    writeBytesToPath(file.getAbsolutePath(), bytes);
    scanMedia(file.getAbsolutePath(), mime);
    return { ok: true, path: file.getAbsolutePath(), message: '' };
  } catch (e) {
    const raw = (e as Error).message || '位置不可用';
    const hint = /denied|permission|EACCES|not writable/i.test(raw) ? '（可在设置中改选自建文件夹）' : '';
    return { ok: false, path: target, message: `写入失败：${raw}${hint}` };
  }
}
