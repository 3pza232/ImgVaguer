<script setup lang="ts">
/**
 * 性能分析浮层：本批的耗时构成与逐张明细。
 *
 * 只呈现结果列表里看不到的信息——结果列表已有逐张体积，
 * 这里给出的是分段耗时构成、每张的时间份额与处理速度，避免同一个数据出现两遍。
 * 口径与桌面端共用 @/core/stats，两端读到的名字与算法完全一致。
 */
import {
  composeSlices,
  formatBytes,
  formatMs,
  formatRatio,
  overheadLabel,
  statRows,
  summarize,
  type StageKey,
  type StageTimes,
  type BatchStats,
} from '@/core/stats';
import { computed } from 'vue';

const props = defineProps<{ stats: BatchStats | null }>();
defineEmits<{ (e: 'close'): void }>();

const summary = computed(() => (props.stats ? summarize(props.stats) : null));
const slices = computed(() =>
  summary.value ? composeSlices(summary.value, overheadLabel(props.stats?.mode ?? null)) : [],
);
const rows = computed(() => (summary.value && props.stats ? statRows(props.stats, summary.value) : []));
const title = computed(() => (props.stats?.op === 'decrypt' ? '解密' : '加密'));

function stageMs(key: StageKey | 'overhead'): string {
  const s = summary.value;
  if (!s) return '';
  return formatMs(key === 'overhead' ? s.overheadMs : (s.stages as StageTimes)[key]);
}
</script>

<template>
  <view class="mask" @click="$emit('close')">
    <view class="sheet" @click.stop>
      <view class="head">
        <text class="head-title">─ 性能分析</text>
        <text class="head-x" hover-class="pressed" @click="$emit('close')">×</text>
      </view>

      <scroll-view v-if="summary" class="body" scroll-y :show-scrollbar="false">
        <view class="sub">
          <text class="tag">{{ title }}</text>
          <text v-if="stats?.mode" class="tag dim">{{ stats.mode }}</text>
          <text class="sub-txt">
            {{ summary.count }} 张 · 成功 {{ summary.okCount }}<template v-if="summary.failCount"> · 失败 {{ summary.failCount }}</template>
          </text>
        </view>

        <view class="cards">
          <view class="card">
            <text class="card-k">总耗时</text>
            <text class="card-v">{{ formatMs(summary.totalMs) }}</text>
            <text class="card-s">批级开销 {{ formatMs(summary.overheadMs) }}</text>
          </view>
          <view class="card">
            <text class="card-k">平均每张</text>
            <text class="card-v">{{ formatMs(summary.avgMs) }}</text>
            <text class="card-s">最慢 {{ formatMs(summary.maxMs) }}</text>
          </view>
          <view class="card">
            <text class="card-k">{{ stats?.op === 'decrypt' ? '加密图 → 还原' : '原图 → 输出' }}</text>
            <text class="card-v">{{ formatRatio(summary.sizeRatio) }}</text>
            <text class="card-s">{{ formatBytes(summary.inBytes) }} → {{ formatBytes(summary.outBytes) }}</text>
          </view>
          <view class="card">
            <text class="card-k">处理速度</text>
            <text class="card-v">{{ summary.tenKPixelsPerSec.toFixed(1) }}</text>
            <text class="card-s">万像素 / 秒</text>
          </view>
        </view>

        <text class="sec">耗时构成</text>
        <view class="stack">
          <view
            v-for="s in slices"
            :key="s.key"
            class="stack-seg"
            :class="`st-${s.key}`"
            :style="{ width: s.percent + '%' }"
          />
        </view>
        <view class="legend">
          <view v-for="s in slices" :key="s.key" class="lg-row">
            <view class="dot" :class="`st-${s.key}`" />
            <text class="lg-name">{{ s.label }}</text>
            <text class="lg-val">{{ s.percent }}%</text>
            <text class="lg-ms">{{ stageMs(s.key) }}</text>
          </view>
        </view>

        <text class="sec">逐张明细</text>
        <view class="rows">
          <view v-for="(r, i) in rows" :key="i" class="row">
            <text class="mark" :class="r.ok ? 'ok' : 'bad'">{{ r.ok ? '✓' : '✗' }}</text>
            <text class="row-name">{{ r.name }}</text>
            <text class="row-share">{{ r.percent }}%</text>
            <text class="row-ms">{{ formatMs(r.ms) }}</text>
          </view>
          <view v-for="(r, i) in rows" :key="'bar' + i" class="bar-row">
            <view class="bar"><view class="bar-fill" :class="{ off: !r.ok }" :style="{ width: r.width + '%' }" /></view>
          </view>
        </view>
      </scroll-view>

      <view v-else class="empty">本批没有性能数据。</view>
    </view>
  </view>
</template>

<style scoped>
.mask {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 60;
  background: rgba(5, 7, 5, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40rpx 24rpx;
}

.sheet {
  width: 100%;
  max-height: 82vh;
  background: #10150f;
  border: 1px solid #3a4f33;
  display: flex;
  flex-direction: column;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20rpx 24rpx;
  border-bottom: 1px solid #243020;
}

.head-title {
  color: #b3c4a6;
  font-size: 26rpx;
}

.head-x {
  color: #b3c4a6;
  font-size: 32rpx;
  line-height: 1;
  padding: 0 10rpx;
}

.body {
  flex: 1;
  padding: 16rpx 24rpx 24rpx;
}

.sub {
  display: flex;
  align-items: center;
  margin-bottom: 16rpx;
}

.tag {
  color: #93c572;
  border: 1px solid #3a4f33;
  font-size: 22rpx;
  padding: 2rpx 10rpx;
  margin-right: 12rpx;
}

.tag.dim {
  color: #66795c;
  border-color: #243020;
}

.sub-txt {
  color: #66795c;
  font-size: 22rpx;
}

.cards {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
}

.card {
  width: 48%;
  background: #0c110c;
  border: 1px solid #243020;
  padding: 14rpx 16rpx;
  margin-bottom: 12rpx;
  display: flex;
  flex-direction: column;
}

.card-k {
  color: #66795c;
  font-size: 22rpx;
}

.card-v {
  color: #b3c4a6;
  font-size: 32rpx;
  margin: 4rpx 0;
}

.card-s {
  color: #66795c;
  font-size: 20rpx;
}

.sec {
  display: block;
  color: #66795c;
  font-size: 24rpx;
  margin: 18rpx 0 12rpx;
}

.stack {
  display: flex;
  height: 20rpx;
  background: #0c110c;
  border: 1px solid #243020;
}

.stack-seg {
  height: 100%;
}

.legend {
  margin-top: 8rpx;
}

.lg-row {
  display: flex;
  align-items: center;
  padding: 6rpx 0;
}

.dot {
  width: 14rpx;
  height: 14rpx;
  margin-right: 12rpx;
  background: #66795c;
}

.st-kdf { background: #93c572; }
.st-payload { background: #6ba292; }
.st-pixels { background: #d8b26a; }
.st-output { background: #8a86b8; }
.st-overhead { background: #46543d; }

.lg-name {
  color: #b3c4a6;
  font-size: 24rpx;
  flex: 1;
}

.lg-val {
  color: #b3c4a6;
  font-size: 24rpx;
  width: 80rpx;
  text-align: right;
}

.lg-ms {
  color: #66795c;
  font-size: 24rpx;
  width: 140rpx;
  text-align: right;
}

.rows {
  margin-top: 4rpx;
}

.row {
  display: flex;
  align-items: center;
  padding: 6rpx 0 0;
}

.mark {
  width: 28rpx;
  font-size: 22rpx;
}

.mark.ok { color: #93c572; }
.mark.bad { color: #d8b26a; }

.row-name {
  flex: 1;
  color: #b3c4a6;
  font-size: 24rpx;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.row-share {
  color: #66795c;
  font-size: 22rpx;
  width: 80rpx;
  text-align: right;
}

.row-ms {
  color: #b3c4a6;
  font-size: 24rpx;
  width: 140rpx;
  text-align: right;
}

.bar-row {
  padding: 6rpx 0 0 28rpx;
}

.bar {
  height: 10rpx;
  background: #0c110c;
  border: 1px solid #243020;
}

.bar-fill {
  height: 100%;
  background: #93c572;
  opacity: 0.75;
}

.bar-fill.off {
  background: #d8b26a;
  opacity: 0.4;
}

.note {
  display: flex;
  align-items: flex-start;
  padding: 8rpx 0;
}

.note-name {
  color: #b3c4a6;
  font-size: 24rpx;
  width: 150rpx;
}

.note-txt {
  flex: 1;
  color: #66795c;
  font-size: 22rpx;
  line-height: 1.5;
}

.empty {
  padding: 60rpx 24rpx;
  color: #66795c;
  font-size: 24rpx;
}
</style>
