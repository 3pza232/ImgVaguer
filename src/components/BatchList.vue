<script setup lang="ts">
import { downloadAll, downloadKeyFile, downloadOne } from '@/services/actions';
import { store } from '@/stores/session';
import { computed } from 'vue';

const okCount = computed(() => store.results.filter((r) => r.ok).length);
const visible = computed(() => store.results.length > 0 || !!store.pendingKeyFile);
</script>

<template>
  <div v-if="visible" class="panel">
    <div class="panel-title">─ 结果 ({{ okCount }}/{{ store.results.length }})</div>
    <div class="results">
      <div v-if="store.pendingKeyFile" class="item key-item">
        <span class="ok">⚿</span>
        <span class="name" title="本批加密的密钥文件，请下载后与图像分开保管">
          {{ store.pendingKeyFile.name }}（本批加密密钥）
        </span>
        <button class="link" @click="downloadKeyFile">下载</button>
      </div>
      <div v-for="r in store.results" :key="r.name" class="item">
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
