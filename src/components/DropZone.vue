<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  label: string;
  hint?: string;
  multiple?: boolean;
  /** 限定扩展名（如 ['.ivkey']）；缺省仅接受图像 */
  exts?: string[];
}>();
const emit = defineEmits<{ (e: 'files', files: File[]): void }>();

const dragging = ref(false);
const input = ref<HTMLInputElement>();

function accept(f: File): boolean {
  if (props.exts) {
    const name = f.name.toLowerCase();
    return props.exts.some((e) => name.endsWith(e));
  }
  return f.type.startsWith('image/');
}

function pick(list: FileList | null): void {
  const files = [...(list ?? [])].filter(accept);
  if (files.length) emit('files', files);
  else if (list?.length) emit('files', []); // 有拖入动作但全部被过滤，交由上层提示
}

function onDrop(e: DragEvent): void {
  dragging.value = false;
  pick(e.dataTransfer?.files ?? null);
}

function onPick(e: Event): void {
  const el = e.target as HTMLInputElement;
  pick(el.files);
  el.value = '';
}
</script>

<template>
  <div
    class="dropzone"
    :class="{ dragging }"
    @click="input?.click()"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <div class="dz-label">[ {{ label }} ]</div>
    <div class="dz-hint">{{ hint ?? '点击选择 / 拖入文件' }}</div>
    <input
      ref="input"
      type="file"
      :accept="exts ? exts.join(',') : 'image/*'"
      :multiple="multiple"
      hidden
      @change="onPick"
    />
  </div>
</template>
