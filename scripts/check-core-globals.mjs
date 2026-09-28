/**
 * 移动端 core/ 的宿主全局检查。
 *
 * core/ 是桌面端与移动端共用的纯算法层，但 App（5+ 运行环境）与部分小程序 runtime
 * 并不提供 TextEncoder / TextDecoder / btoa / atob：引用它们只会在真机上报
 * ReferenceError，而模拟器与 H5 都能跑过，问题只会在打包后暴露。
 *
 * 这两类 API 在本项目已有纯 TS 替代（core/text.ts、core/base64.ts），
 * 因此核心层里再出现它们一定是漏改。此脚本把这类问题挡在打包之前。
 *
 * 只扫 core/：platform/ 天生依赖宿主，H5 分支也允许使用浏览器 API。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const coreDir = join(root, 'uniapp', 'ImgVaguer', 'core');
/** 这两个模块正是上述 API 的替代实现，其注释会提到这些名字 */
const ALLOW = new Set(['text.ts', 'base64.ts']);
const FORBIDDEN = /\b(TextEncoder|TextDecoder|btoa|atob)\b/;

/** 注释里出现这些名字属于正常说明（如「不依赖 btoa」），剥掉后再判定；保留行数以便报准行号 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/\/\/[^\n]*/g, '');
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk(coreDir)) {
  if (ALLOW.has(basename(file))) continue;
  stripComments(readFileSync(file, 'utf8'))
    .split('\n')
    .forEach((line, i) => {
      if (FORBIDDEN.test(line)) offenders.push(`${relative(root, file)}:${i + 1}  ${line.trim()}`);
    });
}

if (offenders.length) {
  console.error('移动端 core/ 引用了宿主全局（App / 小程序 runtime 不提供）：');
  for (const line of offenders) console.error(`  ${line}`);
  console.error('请改用 core/text.ts 的 utf8Encode / utf8Decode，或 core/base64.ts 的编解码。');
  process.exit(1);
}
console.log('core/ 宿主全局检查通过：无 TextEncoder / TextDecoder / btoa / atob 引用。');
