/**
 * 应用入口：本工程为 Vue 3（manifest.json 的 vueVersion 已锁定），
 * 故不保留模板中的 Vue 2 分支与其 promisify 适配器。
 */
import { createSSRApp } from 'vue';
import App from './App';

export function createApp() {
  const app = createSSRApp(App);
  return {
    app,
  };
}
