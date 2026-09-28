<script setup lang="ts">
/** 日志抽屉：默认收起；有错误时把手变红提示 */
import { clearLogs, store } from '@/stores/session';
import { computed, ref } from 'vue';

const open = ref(false);

const errCount = computed(
  () => store.logs.filter((l) => l.level === 'info' && (l.text.includes('失败') || l.text.includes('错误'))).length,
);

const lines = computed(() =>
  store.logView === 'brief' ? store.logs.filter((l) => l.level === 'info') : store.logs,
);

/** 日志区高度策略：行数未超上限随内容自适应，超出后固定高度并在区内滚动 */
const LOG_ROW_H = 60;
const LOG_MAX_H = 420;

const linesStyle = computed(() =>
  lines.value.length * LOG_ROW_H > LOG_MAX_H ? { height: `${LOG_MAX_H}rpx` } : {},
);

function toggle(): void {
  open.value = !open.value;
}
</script>

<template>
  <view class="drawer" :class="{ open }">
    <view class="handle" @click="toggle">
      <text class="label">日志</text>
      <text v-if="errCount" class="badge">{{ errCount }} 错误</text>
      <text class="mark">{{ open ? '▾' : '▸' }}</text>
    </view>

    <view v-if="open" class="body">
      <view class="tools">
        <view class="views">
          <text class="tool" :class="{ on: store.logView === 'brief' }" @click="store.logView = 'brief'">精简</text>
          <text class="tool" :class="{ on: store.logView === 'detail' }" @click="store.logView = 'detail'">详情</text>
        </view>
        <text class="tool" @click="clearLogs">清空</text>
      </view>
      <scroll-view
        class="lines"
        scroll-y
        :show-scrollbar="false"
        :style="linesStyle"
        :scroll-top="lines.length * 200"
        :scroll-with-animation="true"
      >
        <view v-for="(l, i) in lines" :key="i" class="line" :class="{ dim: l.level === 'detail' }">
          <text>{{ l.time }} {{ l.text }}</text>
        </view>
        <view v-if="!lines.length" class="line dim"><text>-- 暂无记录 --</text></view>
      </scroll-view>
    </view>
  </view>
</template>

<style scoped>
.drawer {
  border: 1rpx solid var(--line);
  background: var(--panel);
  /* 与上方区块左右对齐（父容器已提供 24rpx 内边距） */
  margin: 0 0 20rpx;
}
.handle {
  display: flex;
  align-items: center;
  padding: 22rpx 24rpx;
}
.label {
  color: var(--acc);
  font-size: 26rpx;
}
.badge {
  margin-left: 16rpx;
  color: var(--err);
  font-size: 22rpx;
}
.mark {
  margin-left: auto;
  color: var(--dim);
}
.body {
  border-top: 1rpx solid var(--line);
  padding: 16rpx 24rpx 20rpx;
}
.tools {
  display: flex;
  align-items: center;
  margin-bottom: 12rpx;
}
.views {
  display: flex;
  border: 1rpx solid var(--line);
}
.tool {
  padding: 6rpx 20rpx;
  font-size: 22rpx;
  color: var(--dim);
}
.tool.on {
  color: var(--acc);
}
.tools > .tool {
  margin-left: auto;
  border: 1rpx solid var(--line);
}
.lines {
  width: 100%;
}
.line {
  font-size: 22rpx;
  color: var(--fg);
  padding: 4rpx 0;
}
.line.dim {
  color: var(--dim);
}
</style>
