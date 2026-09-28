/**
 * uniapp 工程回归测试（Node 侧，无需 HBuilderX）：
 * 1) SFC 结构与模板可编译（覆盖 components 与 pages 全部文件）；
 * 2) 组件 setup 真实执行（守卫 vue-tsc 看不到的运行时错误，如 TDZ 与后置声明）；
 * 3) core 纯逻辑（命名决策、存储路径反解）；
 * 4) Native.js 使用约束（仅真机暴露的坑，以源码扫描固化）。
 *
 * 说明：renderjs 模块与 uni 专有的 :change: 绑定属编译器扩展，Vue 官方编译器不识别，
 * 校验前先剔除；组件执行采用 esbuild 打包 + 注入 vue，避免动态导入限制。
 */
import { buildSync } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as Vue from 'vue';
import { nextTick, reactive } from 'vue';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import { describe, expect, it } from 'vitest';
// core 为纯 TS 且仅用相对导入，可直接在 Node 中单测
import { pickImageName } from '../uniapp/ImgVaguer/core/image-format';
// 存储路径与文件名反解位于 core（纯函数，无平台依赖，可直接单测）
import { baseNameOf, pathOfDocumentUri, pathOfTreeUri } from '../uniapp/ImgVaguer/core/storage-path';

const UNAPP = 'uniapp/ImgVaguer';
const SFC_DIR = `${UNAPP}/components`;
const PAGES_DIR = `${UNAPP}/pages`;

interface SetupBindings {
  index: { value: number };
  coverIndex: { value: number };
  side: { value: string };
}

type ComponentLike = { setup: (props: unknown, ctx: unknown) => SetupBindings };
type Props = Record<string, unknown> & { inputImages: unknown[]; outputImages: unknown[]; covers: unknown[] };

const preview = (src: string): { src: string; name: string } => ({ src, name: `${src}.png` });

/** 按 App 平台裁剪条件编译（脚本 `// #ifdef` 与模板 `<!-- #ifdef -->` 两种写法等价） */
const FLAGS = ['APP-PLUS', 'APP'];

function preprocess(src: string): string {
  const enabled = (expr: string): boolean =>
    expr.split('||').some((orPart) => orPart.split('&&').every((t) => FLAGS.includes(t.trim())));

  const out: string[] = [];
  const stack: { active: boolean; taken: boolean }[] = [];
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:\/\/|<!--)\s*#(ifdef|ifndef|else|endif)\b(.*?)(?:-->)?\s*$/);
    if (m) {
      const kind = m[1];
      const rest = m[2].replace(/-->$/, '');
      if (kind === 'ifdef' || kind === 'ifndef') {
        const cond = enabled(rest);
        const active = kind === 'ifdef' ? cond : !cond;
        stack.push({ active, taken: active });
      } else if (kind === 'else') {
        const top = stack[stack.length - 1];
        top.active = !top.taken;
        top.taken = true;
      } else {
        stack.pop();
      }
      continue;
    }
    if (stack.every((s) => s.active)) out.push(line);
  }
  return out.join('\n');
}

/** 剔除 uni 编译器扩展：renderjs 模块块与 :change: 绑定（官方编译器与类型系统均不支持） */
function stripUniExtras(src: string): string {
  return src
    .replace(/<script\s+module="[\w-]+"[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/\s:change:[\w-]+="[^"]*"/g, '');
}

function readSfc(file: string): string {
  return preprocess(stripUniExtras(readFileSync(file, 'utf8')));
}

/** 编译组件并实例化：esbuild 打包（vue 外置），返回组件对象 */
function loadComponent(name: string): ComponentLike {
  const filename = join(SFC_DIR, name);
  const { descriptor, errors } = parse(readSfc(filename), { filename });
  expect(errors).toEqual([]);
  const code = compileScript(descriptor, { id: `uniapp-${name}` }).content;

  const built = buildSync({
    stdin: { contents: code, resolveDir: UNAPP, loader: 'ts', sourcefile: `${name}.ts` },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vue'],
    tsconfig: join(UNAPP, 'tsconfig.json'),
    logLevel: 'silent',
  });
  const mod = { exports: {} as { default?: ComponentLike } };
  const requireShim = (id: string): unknown => (id === 'vue' ? Vue : undefined);
  new Function('exports', 'require', 'module', built.outputFiles[0].text)(
    mod.exports,
    requireShim,
    mod,
  );
  expect(mod.exports.default).toBeTruthy();
  return mod.exports.default as ComponentLike;
}

/** 以响应式 props 执行 setup，返回 props 代理供用例修改以触发更新 */
function mount(comp: ComponentLike, initial: Partial<Props>): { props: Props; b: SetupBindings } {
  const props = reactive({
    inputImages: [],
    outputImages: [],
    covers: [],
    activeSide: 'input',
    ...initial,
  }) as Props;
  const ctx = { attrs: {}, slots: {}, emit: () => undefined, expose: () => undefined };
  return { props, b: comp.setup(props, ctx) };
}

/** 递归收集目录下的 SFC */
function collectVue(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...collectVue(p));
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}

describe('uniapp SFC 结构与模板可编译', () => {
  for (const file of [...collectVue(SFC_DIR), ...collectVue(PAGES_DIR), `${UNAPP}/App.vue`]) {
    it(file, () => {
      const { descriptor, errors } = parse(readSfc(file), { filename: file });
      expect(errors).toEqual([]);
      expect(compileScript(descriptor, { id: file }).content.length).toBeGreaterThan(0);
      // App.vue 为无模板的入口文件，仅在有模板时校验模板
      if (descriptor.template) {
        const tpl = compileTemplate({
          source: descriptor.template.content,
          filename: file,
          id: file,
          compilerOptions: { expressionPlugins: ['typescript'] },
        });
        expect(tpl.errors).toEqual([]);
      }
    });
  }
});

describe('uniapp core/image-format', () => {
  it('命名优先使用选择器给出的原始名', () => {
    expect(pickImageName('假期照片.jpg', 'blob:http://localhost/uuid', null)).toBe('假期照片.jpg');
  });

  it('无原始名时取带扩展名的路径基名', () => {
    expect(pickImageName(undefined, '/tmp/x/IMG_1234.JPG', 'jpg')).toBe('IMG_1234.JPG');
  });

  it('路径亦不可信时生成互不重名的兜底名（回归：曾全部退化为 image.png）', () => {
    const a = pickImageName(undefined, 'blob:http://localhost/6f2b-1', 'png');
    const b = pickImageName(undefined, 'blob:http://localhost/6f2b-2', 'jpg');
    const c = pickImageName(undefined, '_doc/uniapp_temp/compressed', null);
    expect(a).toMatch(/^image-\d+\.png$/);
    expect(b).toMatch(/^image-\d+\.jpg$/);
    expect(c).toMatch(/^image-\d+\.png$/);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('uniapp 存储路径与文件名反解（回归：曾用 ContentResolver.query 取名称，Native.js 下抛 query is not a function）', () => {
  it('tree URI 反解为真实路径（primary 卷根目录由调用方传入）', () => {
    expect(pathOfTreeUri('content://com.android.externalstorage.documents/tree/primary%3ADownload')).toBe(
      '/storage/emulated/0/Download',
    );
    expect(
      pathOfTreeUri('content://com.android.externalstorage.documents/tree/primary%3ADownload', '/mnt/sdcard'),
    ).toBe('/mnt/sdcard/Download');
    expect(pathOfTreeUri('content://com.android.externalstorage.documents/tree/primary%3ADownload%2FImgVaguer')).toBe(
      '/storage/emulated/0/Download/ImgVaguer',
    );
    expect(pathOfTreeUri('content://com.android.externalstorage.documents/tree/primary%3A')).toBe(
      '/storage/emulated/0',
    );
  });

  it('外置卡按卷号映射', () => {
    expect(pathOfTreeUri('content://com.android.externalstorage.documents/tree/1A2B-3C4D%3Aphotos')).toBe(
      '/storage/1A2B-3C4D/photos',
    );
  });

  it('无法映射为路径的 provider 返回空串（由界面如实提示，而非静默失败）', () => {
    expect(pathOfTreeUri('content://com.android.providers.downloads.documents/tree/downloads')).toBe('');
    expect(pathOfTreeUri('content://com.google.android.apps.docs.storage/tree/abc')).toBe('');
  });

  it('文档 URI 反解为真实路径（「从文件夹选择」用它绕开 Native.js 字节搬运）', () => {
    expect(
      pathOfDocumentUri('content://com.android.externalstorage.documents/document/primary%3ADownload%2Fmy.ivkey'),
    ).toBe('/storage/emulated/0/Download/my.ivkey');
    // 下载管理器的 raw: 形式本身就是路径
    expect(
      pathOfDocumentUri('content://com.android.providers.downloads.documents/document/raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2Fa.png'),
    ).toBe('/storage/emulated/0/Download/a.png');
    // 媒体库等无法映射：返回空串，由界面如实提示并附 URI 片段便于排查
    expect(pathOfDocumentUri('content://media/external/images/media/1234')).toBe('');
  });

  it('路径基名去除末尾斜杠', () => {
    expect(baseNameOf('/storage/emulated/0/Download/')).toBe('Download');
    expect(baseNameOf('/storage/emulated/0/Download/ImgVaguer')).toBe('ImgVaguer');
  });
});

describe('uniapp 平台层 Native.js 约束（回归：曾直接点调用 ContentResolver 方法，真机抛 e.openInputStream is not a function）', () => {
  /** 注释会在说明约束时提到被禁用的写法，故先剔除注释再检查实际代码 */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const platformCode = ['app-intent.ts', 'app-picker.ts', 'app-storage.ts'].map((f) =>
    stripComments(readFileSync(join(UNAPP, 'services/platform', f), 'utf8')),
  );

  it('手工取回的实例方法一律经 callJava 反射调用', () => {
    for (const code of platformCode) {
      expect(code).not.toMatch(/\.(query|openInputStream|openOutputStream|takePersistableUriPermission)\(/);
    }
  });

  it('不使用 DocumentsContract 系列重载（其桥接在多端不可靠）', () => {
    for (const code of platformCode) {
      expect(code).not.toContain('DocumentsContract');
    }
  });

  it('私有目录路径由 plus.io 提供，不自行拼接（回归：拼接路径落到进程工作目录，写入"成功"却报「文件不存在」）', () => {
    const storage = stripComments(readFileSync(join(UNAPP, 'services/platform/app-storage.ts'), 'utf8'));
    expect(storage).toContain('toLocalURL');
    expect(storage).not.toContain('convertLocalFileSystemURL');
  });

  it('不做 Native.js 字节搬运（回归：Files.copy 不可用、read(byte[]) 出参不回填，会产出全零文件）', () => {
    const picker = stripComments(readFileSync(join(UNAPP, 'services/platform/app-picker.ts'), 'utf8'));
    expect(picker).not.toContain('read(byte');
    expect(picker).not.toContain('java.nio.file.Files');
    expect(picker).toContain('readFileBytes');
  });
});

describe('uniapp StackPreview', () => {
  it('setup 可正常执行（回归：曾被后置声明的 list 触发 TDZ）', () => {
    const comp = loadComponent('StackPreview.vue');
    const { b } = mount(comp, { inputImages: [preview('a'), preview('b')] });
    expect(b.index.value).toBe(0);
    expect(b.side.value).toBe('input');
  });

  it('删除当前张：索引收敛到上一张；清空后归零', async () => {
    const comp = loadComponent('StackPreview.vue');
    const { props, b } = mount(comp, { inputImages: [preview('a'), preview('b'), preview('c')] });

    b.index.value = 2;
    await nextTick();
    props.inputImages = [preview('a'), preview('b')];
    await nextTick();
    expect(b.index.value).toBe(1);

    props.inputImages = [];
    await nextTick();
    expect(b.index.value).toBe(0);
  });

  it('混淆图层列表缩短时 PiP 索引同步收敛', async () => {
    const comp = loadComponent('StackPreview.vue');
    const { props, b } = mount(comp, { covers: [preview('c1'), preview('c2')] });

    b.coverIndex.value = 1;
    await nextTick();
    props.covers = [preview('c1')];
    await nextTick();
    expect(b.coverIndex.value).toBe(0);
  });

  it('切换 INPUT / OUTPUT 图集时索引归零', async () => {
    const comp = loadComponent('StackPreview.vue');
    const { props, b } = mount(comp, {
      inputImages: [preview('a'), preview('b')],
      outputImages: [preview('out1')],
    });

    b.index.value = 1;
    await nextTick();
    props.activeSide = 'output';
    await nextTick();
    expect(b.side.value).toBe('output');
    expect(b.index.value).toBe(0);
  });
});
