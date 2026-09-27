<script setup lang="ts">
import { clearLogs, store } from '@/stores/session';
import { computed, nextTick, ref, watch } from 'vue';

const el = ref<HTMLDivElement>();
const shown = computed(() =>
  store.logView === 'detail' ? store.logs : store.logs.filter((l) => l.level === 'info'),
);

watch(
  () => [shown.value.length, store.logView],
  async () => {
    await nextTick();
    if (el.value) el.value.scrollTop = el.value.scrollHeight;
  },
);
</script>

<template>
  <div class="logbar">
    <div class="log-rail">
      <button
        class="rail-btn"
        :class="{ on: store.logView === 'brief' }"
        title="精简视图"
        @click="store.logView = 'brief'"
      >
        简
      </button>
      <button
        class="rail-btn"
        :class="{ on: store.logView === 'detail' }"
        title="详情视图（步骤 / 参数 / 方法）"
        @click="store.logView = 'detail'"
      >
        详
      </button>
      <button class="clear-x rail-bottom" title="清除终端记录" @click="clearLogs">×</button>
    </div>
    <div ref="el" class="log">
      <div
        v-for="(line, i) in shown"
        :key="i"
        :class="{
          'detail-line': line.level === 'detail',
          'err-line': line.level === 'info' && (line.text.includes('失败') || line.text.includes('错误')),
        }"
      >
        <span class="log-time">{{ line.time }}</span> {{ line.text }}
      </div>
      <div v-if="!shown.length" style="color: var(--dim)">-- 日志为空 --</div>
    </div>
  </div>
</template>
