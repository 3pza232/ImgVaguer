<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';

export interface StackImage {
  url: string;
  name?: string;
}

const props = withDefaults(
  defineProps<{
    images: StackImage[];
    tag: string;
    /** 覆盖图小窗（PiP）；多层时支持滚轮/箭头切换与点击放大 */
    covers?: StackImage[];
  }>(),
  { covers: () => [] },
);

const index = ref(0);
const coverIndex = ref(0);
const zoomSrc = ref<StackImage | null>(null);

const count = computed(() => props.images.length);
const coverCount = computed(() => props.covers.length);
const current = computed(() => props.images[index.value]);
const currentCover = computed(() => props.covers[coverIndex.value]);

// 列表收缩时回卷索引，避免越界空白
watch(count, (n) => {
  if (index.value >= n) index.value = 0;
  if (n === 0 && zoomSrc.value && !isCoverZoom.value) zoomSrc.value = null;
});
watch(coverCount, (n) => {
  if (coverIndex.value >= n) coverIndex.value = 0;
});

const isCoverZoom = computed(
  () => !!zoomSrc.value && props.covers.some((c) => c.url === zoomSrc.value!.url),
);

function step(d: number): void {
  if (count.value) index.value = (index.value + d + count.value) % count.value;
}

function stepCover(d: number): void {
  if (coverCount.value) coverIndex.value = (coverIndex.value + d + coverCount.value) % coverCount.value;
}

function onWheel(e: WheelEvent): void {
  step(e.deltaY > 0 ? 1 : -1);
}

function onCoverWheel(e: WheelEvent): void {
  stepCover(e.deltaY > 0 ? 1 : -1);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') zoomSrc.value = null;
}

watch(zoomSrc, (v) => {
  if (v) window.addEventListener('keydown', onKey);
  else window.removeEventListener('keydown', onKey);
});

onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="pane" @wheel.prevent="onWheel">
    <span class="tag">{{ tag }}</span>
    <template v-if="current">
      <img
        class="stack-img"
        :class="{ stacked: count > 1 }"
        :src="current.url"
        :alt="current.name ?? tag"
        :title="`${current.name ?? tag}（点击放大）`"
        @click="zoomSrc = current"
      />
      <span v-if="count > 1" class="pager">
        <button class="pg" title="上一张" @click.stop="step(-1)">‹</button>
        {{ index + 1 }}/{{ count }}
        <button class="pg" title="下一张" @click.stop="step(1)">›</button>
      </span>
    </template>
    <span v-else class="empty">∅ 无图像</span>

    <div
      v-if="currentCover"
      class="pip-wrap"
      :title="currentCover.name ?? '覆盖图'"
      @wheel.stop.prevent="onCoverWheel"
      @click.stop="zoomSrc = currentCover"
    >
      <span class="pip-tag">COVER<template v-if="coverCount > 1"> {{ coverIndex + 1 }}/{{ coverCount }}</template></span>
      <img :src="currentCover.url" alt="cover" />
      <span v-if="coverCount > 1" class="pip-pager">
        <button class="pg" title="上一层" @click.stop="stepCover(-1)">‹</button>
        <button class="pg" title="下一层" @click.stop="stepCover(1)">›</button>
      </span>
    </div>

    <div v-if="zoomSrc" class="zoom-backdrop" @click.self="zoomSrc = null" @wheel.prevent.stop="onWheel">
      <img :src="zoomSrc.url" :alt="zoomSrc.name ?? tag" />
      <span class="zoom-cap">{{ zoomSrc.name ?? tag }} · 点击空白处或 Esc 返回</span>
    </div>
  </div>
</template>
