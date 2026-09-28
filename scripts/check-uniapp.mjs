/**
 * uniapp 工程静态校验：按平台裁剪条件编译后，用 vue-tsc 全量检查（含 .vue）。
 *
 * 用法：node scripts/check-uniapp.mjs [h5|mp-weixin|app-plus ...]（缺省检查全部）
 * 说明：HBuilderX 工程本身零 npm 依赖，故校验借桌面工程的 vue-tsc 运行；
 *      平台专属依赖均已加 // #ifdef 围栏，故启用 noUnusedLocals 同时守护死代码。
 *      临时工程写入 .tmp-uniapp-verify/（已 gitignore），全部通过后自动清理。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const SRC = 'uniapp/ImgVaguer';
const TMP = '.tmp-uniapp-verify';
const SUB_DIRS = ['core', 'services', 'stores', 'types', 'libs', 'components', 'pages'];
const FLAGS = { h5: ['H5'], 'mp-weixin': ['MP-WEIXIN'], 'app-plus': ['APP-PLUS', 'APP'] };

const requested = process.argv.slice(2).filter((a) => FLAGS[a]);
const platforms = requested.length ? requested : Object.keys(FLAGS);

/**
 * 过滤条件编译指令（按行，够本项目使用）：
 * 脚本用 `// #ifdef`，模板用 `<!-- #ifdef -->`，两种写法在编译期等价。
 */
function preprocess(text, flags) {
  const enabled = (expr) =>
    expr.split('||').some((orPart) => orPart.split('&&').every((token) => flags.includes(token.trim())));

  const out = [];
  const stack = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:\/\/|<!--)\s*#(ifdef|ifndef|else|endif)\b(.*?)(?:-->)?\s*$/);
    if (m) {
      const [, kind] = m;
      const rest = m[2].replace(/-->$/, '');
      if (kind === 'ifdef' || kind === 'ifndef') {
        const cond = enabled(rest.trim());
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

function walk(dir, cb) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, cb);
    else cb(p);
  }
}

const VUE_SHIM =
  "declare module '*.vue' {\n  import type { DefineComponent } from 'vue';\n  const c: DefineComponent<{}, {}, any>;\n  export default c;\n}\ndeclare const uni: any;\ndeclare const wx: any;\ndeclare const plus: any;\n";

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2019',
    module: 'ESNext',
    moduleResolution: 'node',
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    noUnusedLocals: true,
    baseUrl: '.',
    paths: { '@/*': ['./*'] },
    lib: ['ES2019', 'DOM'],
    types: [],
  },
  include: ['**/*.ts', '**/*.vue'],
};

/** 生成某平台的临时工程目录 */
function build(platformName) {
  const dir = join(TMP, platformName);
  mkdirSync(dir, { recursive: true });
  for (const sub of SUB_DIRS) cpSync(join(SRC, sub), join(dir, sub), { recursive: true });
  cpSync(join(SRC, 'App.vue'), join(dir, 'App.vue'));
  cpSync(join(SRC, 'app-meta.ts'), join(dir, 'app-meta.ts'));

  walk(dir, (p) => {
    if (!p.endsWith('.ts') && !p.endsWith('.vue')) return;
    const before = readFileSync(p, 'utf8');
    let after = preprocess(before, FLAGS[platformName]);
    // renderjs 绑定（:change:prop="模块.方法"）由 uni 编译器在视图层解析，
    // 类型系统看不到该模块，故校验时剔除该属性（不影响真实构建）
    if (p.endsWith('.vue')) after = after.replace(/\s:change:[\w-]+="[^"]*"/g, '');
    if (after !== before) writeFileSync(p, after, 'utf8');
  });

  writeFileSync(join(dir, 'vue-shim.d.ts'), VUE_SHIM);
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 2));
  return dir;
}

rmSync(TMP, { recursive: true, force: true });
const require = createRequire(import.meta.url);
const vueTsc = require.resolve('vue-tsc/bin/vue-tsc.js');
let failed = 0;

for (const platformName of platforms) {
  const dir = build(platformName);
  const res = spawnSync(process.execPath, [vueTsc, '--noEmit', '-p', join(dir, 'tsconfig.json')], {
    encoding: 'utf8',
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  if (output) {
    failed++;
    console.log(`\n== ${platformName} 存在问题 ==\n${output}`);
  } else {
    console.log(`== ${platformName} : ZERO ERRORS`);
  }
}

if (failed) {
  console.log(`\n${failed} 个平台未通过；临时工程保留于 ${TMP}/ 便于排查。`);
  process.exit(1);
}
rmSync(TMP, { recursive: true, force: true });
console.log('\n全部平台通过（临时工程已清理）。');
