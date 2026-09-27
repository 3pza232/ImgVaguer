<script setup lang="ts">
import { store } from '@/stores/session';
import { nextTick, ref, watch } from 'vue';

const el = ref<HTMLDivElement>();

watch(
  () => store.logs.length,
  async () => {
    await nextTick();
    if (el.value) el.value.scrollTop = el.value.scrollHeight;
  },
);
</script>

<template>
  <div ref="el" class="log">
    <div v-for="(line, i) in store.logs" :key="i" :class="{ 'err-line': line.includes('失败') || line.includes('错误') }">
      {{ line }}
    </div>
    <div v-if="!store.logs.length" style="color: var(--dim)">-- 日志为空 --</div>
  </div>
</template>
