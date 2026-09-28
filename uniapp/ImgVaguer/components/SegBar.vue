<script setup lang="ts">
/** 分段选择器：触屏主切换控件（加密/解密、混淆方式、保护方式等复用） */
interface Option {
  value: string;
  label: string;
}

defineProps<{ modelValue: string; options: Option[] }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();
</script>

<template>
  <view class="seg">
    <view
      v-for="o in options"
      :key="o.value"
      class="seg-item"
      :class="{ active: modelValue === o.value }"
      @click="emit('update:modelValue', o.value)"
    >
      {{ o.label }}
    </view>
  </view>
</template>

<style scoped>
.seg {
  display: flex;
  border: 1rpx solid var(--line);
  background: var(--sunken);
}
.seg-item {
  flex: 1;
  text-align: center;
  padding: 20rpx 8rpx;
  color: var(--dim);
  font-size: 26rpx;
}
.seg-item.active {
  color: var(--acc);
  border-bottom: 2rpx solid var(--acc);
}
</style>
