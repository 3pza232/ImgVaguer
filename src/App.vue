<script setup lang="ts">
import BatchList from '@/components/BatchList.vue';
import DocsPanel from '@/components/DocsPanel.vue';
import DropZone from '@/components/DropZone.vue';
import ParamPanel from '@/components/ParamPanel.vue';
import PreviewPane from '@/components/PreviewPane.vue';
import SettingsPanel from '@/components/SettingsPanel.vue';
import TaskLog from '@/components/TaskLog.vue';
import { addCovers, addTargets, applyDefaultCover } from '@/services/actions';
import { clearCovers, clearTargets, moveCover, removeCover, removeTarget, store } from '@/stores/session';
import { computed, onMounted, ref } from 'vue';

const appVersion = __APP_VERSION__;

const showSettings = ref(false);
const showDocs = ref(false);
/** 文档是否从设置面板打开：关闭时返回设置 */
const docsReturn = ref(false);

const coverDrag = ref<number | null>(null);
const coverDragOver = ref<number | null>(null);

onMounted(() => void applyDefaultCover());

const status = computed(() => (store.busy ? '处理中…' : '就绪'));

const modeLabel = computed(() => {
  if (store.op === 'decrypt') return '解密';
  return store.mode === 'scramble' ? '加密·密文混淆' : '加密·覆盖合成';
});

const protectionLabel = computed(
  () => ({ none: '无', password: '口令', keyfile: '密钥文件' })[store.protection],
);

const targetHint = computed(() =>
  store.op === 'decrypt' ? '拖入 ImgVaguer 生成的 PNG（可多选）' : '点击选择 / 拖入（可多选）',
);

const resultCount = computed(() => store.batches[store.batchIndex]?.items.length ?? 0);

function openDocsFromSettings(): void {
  docsReturn.value = true;
  showSettings.value = false;
  showDocs.value = true;
}

function closeDocs(): void {
  showDocs.value = false;
  if (docsReturn.value) {
    docsReturn.value = false;
    showSettings.value = true;
  }
}

function onCoverDrop(i: number): void {
  if (coverDrag.value !== null && coverDrag.value !== i) moveCover(coverDrag.value, i);
  coverDrag.value = null;
  coverDragOver.value = null;
}
</script>

<template>
  <div class="app">
    <header class="titlebar">
      <span class="brand">█ ImgVaguer</span>
      <span class="titlebar-right">
        <span class="meta">image obfuscation terminal · v{{ appVersion }} [by pza]</span>
        <button class="icon-btn" title="设置" aria-label="设置" @click="showSettings = true">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </span>
    </header>

    <main class="main">
      <aside class="side">
        <div class="panel">
          <div class="panel-title">─ 输入</div>
          <DropZone label="目标图像" multiple :hint="targetHint" @files="addTargets" />
          <div v-if="store.targets.length" class="file-list">
            <div v-for="(t, i) in store.targets" :key="t.name + i" class="item">
              <span class="fname" :title="t.name">{{ t.name }}</span>
              <span class="dims">{{ t.raster.width }}x{{ t.raster.height }}</span>
              <button class="link del" title="移除" @click="removeTarget(i)">×</button>
            </div>
            <div class="item foot">
              <span>共 {{ store.targets.length }} 个</span>
              <button class="link" @click="clearTargets">清空</button>
            </div>
          </div>
        </div>

        <div v-if="store.op === 'encrypt' && store.mode === 'overlay'" class="panel">
          <div class="panel-title">─ 混淆图层</div>
          <DropZone label="混淆图像" hint="拖入 / 点击追加图层" multiple @files="addCovers" />
          <div v-if="store.covers.length" class="file-list">
            <div
              v-for="(c, i) in store.covers"
              :key="c.name + i"
              class="item draggable"
              :class="{ 'drag-over': coverDragOver === i && coverDrag !== i }"
              draggable="true"
              @dragstart="coverDrag = i"
              @dragend="coverDrag = null; coverDragOver = null"
              @dragenter.prevent="coverDragOver = i"
              @dragleave="coverDragOver === i && (coverDragOver = null)"
              @dragover.prevent
              @drop.prevent="onCoverDrop(i)"
            >
              <span class="grip" title="拖动调整层序">≡</span>
              <span class="dims">L{{ i + 1 }}</span>
              <span class="fname" :title="c.name">{{ c.name }}</span>
              <button class="link del" title="移除" @click="removeCover(i)">×</button>
            </div>
            <div class="item foot">
              <span>共 {{ store.covers.length }} 层</span>
              <button class="link" @click="clearCovers">清空</button>
            </div>
          </div>
          <div v-if="store.covers.length" class="row" style="margin-top: 8px; margin-bottom: 0">
            <label>目标图所在层</label>
            <select v-model.number="store.targetLayer">
              <option
                v-for="p in store.covers.length + 1"
                :key="p"
                :value="store.covers.length + 1 - p"
              >
                第 {{ p }} 层{{ p === 1 ? '（顶层）' : p === store.covers.length + 1 ? '（底层）' : '' }}
              </option>
            </select>
          </div>
        </div>

        <ParamPanel />
      </aside>

      <section class="stage">
        <PreviewPane />
        <BatchList />
      </section>
    </main>

    <TaskLog />

    <footer class="statusbar">
      <span>状态: <b>{{ status }}</b></span>
      <span>模式: <b>{{ modeLabel }}</b></span>
      <span v-if="store.op === 'encrypt'">保护: <b>{{ protectionLabel }}</b></span>
      <span>目标: <b>{{ store.targets.length }}</b></span>
      <span>结果: <b>{{ resultCount }}</b></span>
      <span>批次: <b>{{ store.batches.length }}</b></span>
    </footer>

    <SettingsPanel v-if="showSettings" @close="showSettings = false" @docs="openDocsFromSettings" />
    <DocsPanel v-if="showDocs" @close="closeDocs" />
  </div>
</template>
