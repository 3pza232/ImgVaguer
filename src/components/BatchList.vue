<script setup lang="ts">
import { downloadAll, downloadKeyFile, downloadOne } from '@/services/actions';
import { removeBatch, stepBatch, store } from '@/stores/session';
import { computed } from 'vue';

const batch = computed(() => store.batches[store.batchIndex] ?? null);
const okCount = computed(() => batch.value?.items.filter((r) => r.ok).length ?? 0);
</script>

<template>
  <div v-if="batch" class="panel">
    <div class="panel-title">
      ─ 结果
      <button class="pg" title="上一批" :disabled="store.batches.length < 2" @click="stepBatch(-1)">‹</button>
      <span class="pg-count">{{ store.batchIndex + 1 }}/{{ store.batches.length }}</span>
      <button class="pg" title="下一批" :disabled="store.batches.length < 2" @click="stepBatch(1)">›</button>
      <span class="result-sep">|</span>
      <button class="del-x" title="删除本批结果" @click="removeBatch(store.batchIndex)">×</button>
    </div>

    <div class="results">
      <div v-if="batch.keyFile" class="item key-item">
        <span class="ok">⚿</span>
        <span class="name" :title="batch.keyFile.name">{{ batch.keyFile.name }}（本批加密密钥）</span>
        <button class="link" @click="downloadKeyFile">下载</button>
      </div>
      <div v-for="(r, i) in batch.items" :key="i" class="item">
        <span :class="r.ok ? 'ok' : 'bad'">{{ r.ok ? '✓' : '✗' }}</span>
        <span class="name" :title="r.error">{{ r.name }}<template v-if="r.error"> — {{ r.error }}</template></span>
        <button v-if="r.ok" class="link" @click="downloadOne(r)">下载</button>
      </div>
    </div>

    <div class="btn-row" style="margin-top: 8px">
      <button class="btn" :disabled="!okCount" @click="downloadAll">
        [ 全部下载{{ okCount > 1 ? ' (.zip)' : '' }} ]
      </button>
    </div>
  </div>
</template>
