<script setup lang="ts">
/** 折叠分组：移动端把参数收纳于此，保持首屏聚焦 */
import { ref } from 'vue';

const props = withDefaults(defineProps<{ title: string; open?: boolean; summary?: string }>(), {
  open: false,
  summary: '',
});
const expanded = ref(props.open);
</script>

<template>
  <view class="card">
    <view class="head" @click="expanded = !expanded">
      <text class="title">{{ title }}</text>
      <text v-if="summary && !expanded" class="summary">{{ summary }}</text>
      <text class="mark">{{ expanded ? '▾' : '▸' }}</text>
    </view>
    <view v-if="expanded" class="body">
      <slot />
    </view>
  </view>
</template>

<style scoped>
.card {
  border: 1rpx solid var(--line);
  background: var(--panel);
  margin-bottom: 20rpx;
}
.head {
  display: flex;
  align-items: center;
  padding: 24rpx;
}
.title {
  color: var(--acc);
  font-size: 26rpx;
}
.summary {
  flex: 1;
  text-align: right;
  color: var(--dim);
  font-size: 22rpx;
  margin-right: 12rpx;
}
.mark {
  margin-left: auto;
  color: var(--dim);
}
.body {
  padding: 0 24rpx 24rpx;
}
</style>
