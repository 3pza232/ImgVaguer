<script setup lang="ts">
import StackPane, { type StackImage } from '@/components/StackPane.vue';
import { store } from '@/stores/session';
import { computed } from 'vue';

const inputImages = computed<StackImage[]>(() =>
  store.targets.map((t) => ({ url: t.url, name: t.name })),
);
const outputImages = computed<StackImage[]>(() => {
  const batch = store.batches[store.batchIndex];
  if (!batch) return [];
  return batch.items.filter((r) => r.ok).map((r) => ({ url: r.url, name: r.name }));
});
// 需要覆盖图层的混淆方式（覆盖合成、密文 + 覆盖）在加密时，INPUT 上以 PiP 显示图层（上层在前）
const coverImages = computed<StackImage[]>(() => {
  if (store.op !== 'encrypt' || store.mode === 'scramble') return [];
  return [...store.covers].reverse().map((c) => ({ url: c.url, name: c.name }));
});
</script>

<template>
  <div class="preview">
    <StackPane tag="INPUT" :images="inputImages" :covers="coverImages" />
    <StackPane tag="OUTPUT" :images="outputImages" />
  </div>
</template>
