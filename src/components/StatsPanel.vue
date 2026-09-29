<script setup lang="ts">
import { composeSlices, formatBytes, formatMs, formatRatio, overheadLabel, statRows, summarize } from '@/core/stats';
import { store } from '@/stores/session';
import { computed } from 'vue';

defineEmits<{ (e: 'close'): void }>();

/** 本批台账：面板跟随结果区的批次翻页 */
const stats = computed(() => store.batches[store.batchIndex]?.stats ?? null);
const summary = computed(() => (stats.value ? summarize(stats.value) : null));

/** 圆环周长：半径 44，用于把百分比换算成描边长度 */
const C = 2 * Math.PI * 44;

/** 构成图切片：份额与名称取自共享的 composeSlices，这里只补画弧所需的 dash / offset */
const slices = computed(() => {
  const s = summary.value;
  if (!s) return [];
  let acc = 0;
  return composeSlices(s, overheadLabel(stats.value?.mode ?? null)).map((slice) => {
    const dash = (slice.percent / 100) * C;
    const out = { ...slice, dash: `${dash} ${C}`, offset: -acc };
    acc += dash;
    return out;
  });
});

/** 逐张明细行 */
const rows = computed(() => (summary.value && stats.value ? statRows(stats.value, summary.value) : []));

const title = computed(() => (stats.value?.op === 'decrypt' ? '解密' : '加密'));
</script>

<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal stats">
      <div class="modal-head">
        <div class="panel-title" style="margin-bottom: 0">─ 性能分析</div>
        <button class="x-close" title="关闭" @click="$emit('close')">×</button>
      </div>

      <div v-if="summary" class="stats-body">
        <div class="stats-sub">
          <span class="tag">{{ title }}</span>
          <span v-if="stats?.mode" class="tag dim">{{ stats.mode }}</span>
          <span class="stats-sub-txt">
            {{ summary.count }} 张 · 成功 {{ summary.okCount }}<template v-if="summary.failCount"> · 失败 {{ summary.failCount }}</template>
          </span>
        </div>

        <div class="cards">
          <div class="card">
            <span class="card-k">总耗时</span>
            <span class="card-v">{{ formatMs(summary.totalMs) }}</span>
            <span class="card-s">批级开销 {{ formatMs(summary.overheadMs) }}</span>
          </div>
          <div class="card">
            <span class="card-k">平均每张</span>
            <span class="card-v">{{ formatMs(summary.avgMs) }}</span>
            <span class="card-s">
              最慢 {{ formatMs(summary.maxMs) }}<template v-if="summary.slowest"> · {{ summary.slowest.name }}</template>
            </span>
          </div>
          <div class="card">
            <span class="card-k">{{ stats?.op === 'decrypt' ? '加密图 → 还原' : '原图 → 输出' }}</span>
            <span class="card-v">{{ formatRatio(summary.sizeRatio) }}</span>
            <span class="card-s">{{ formatBytes(summary.inBytes) }} → {{ formatBytes(summary.outBytes) }}</span>
          </div>
          <div class="card">
            <span class="card-k">处理速度</span>
            <span class="card-v">{{ summary.tenKPixelsPerSec.toFixed(1) }}</span>
            <span class="card-s">万像素 / 秒</span>
          </div>
        </div>

        <div class="sec-title">耗时构成</div>
        <div class="compose">
          <svg class="donut" viewBox="0 0 100 100" role="img" aria-label="耗时构成">
            <circle class="donut-track" cx="50" cy="50" r="44" />
            <circle
              v-for="s in slices"
              :key="s.key"
              class="donut-slice"
              :class="`st-${s.key}`"
              cx="50"
              cy="50"
              r="44"
              :stroke-dasharray="s.dash"
              :stroke-dashoffset="s.offset"
            />
          </svg>
          <ul class="legend">
            <li v-for="s in slices" :key="s.key">
              <i class="dot" :class="`st-${s.key}`" />
              <span class="lg-name">{{ s.label }}</span>
              <span class="lg-val">{{ s.percent }}%</span>
              <span v-if="s.key !== 'overhead'" class="lg-ms">{{ formatMs(summary.stages[s.key]) }}</span>
              <span v-else class="lg-ms">{{ formatMs(summary.overheadMs) }}</span>
            </li>
          </ul>
        </div>

        <div class="sec-title">逐张明细</div>
        <div class="rows">
          <div v-for="(r, i) in rows" :key="i" class="row-item">
            <span class="st-mark" :class="r.ok ? 'ok' : 'bad'">{{ r.ok ? '✓' : '✗' }}</span>
            <span class="row-name" :title="r.name">{{ r.name }}</span>
            <span class="row-bar"><i :style="{ width: r.width + '%' }" :class="{ off: !r.ok }" /></span>
            <span class="row-share">{{ r.percent }}%</span>
            <span class="row-ms">{{ formatMs(r.ms) }}</span>
          </div>
        </div>
      </div>

      <div v-else class="stats-empty">本批没有性能数据。</div>
    </div>
  </div>
</template>

<style scoped>
/* 外壳已有内边距，这里只留纵向间距，正文与标题左对齐 */
.stats-body {
  padding: 2px 0 4px;
  overflow-y: auto;
}

.stats-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 0 12px;
  font-size: 12px;
  color: var(--dim);
}

.tag {
  padding: 1px 6px;
  border: 1px solid var(--line-hi);
  color: var(--acc);
}

.tag.dim {
  color: var(--dim);
  border-color: var(--line);
}

/* 窄屏自动折行，卡片可压缩，绝不出现横向滚动 */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 8px 10px;
  background: var(--sunken);
  border: 1px solid var(--line);
}

.card-k {
  font-size: 11px;
  color: var(--dim);
}

.card-v {
  font-size: 18px;
  color: var(--fg);
  line-height: 1.2;
}

.card-s {
  font-size: 11px;
  color: var(--dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sec-title {
  margin: 16px 0 8px;
  color: var(--dim);
  font-size: 12px;
}

.compose {
  display: flex;
  align-items: center;
  gap: 18px;
}

.donut {
  width: 132px;
  height: 132px;
  flex: none;
  transform: rotate(-90deg);
}

.donut-track {
  fill: none;
  stroke: var(--line);
  stroke-width: 12;
}

.donut-slice {
  fill: none;
  stroke-width: 12;
  stroke-linecap: butt;
}

.legend {
  margin: 0;
  padding: 0;
  list-style: none;
  flex: 1;
}

.legend li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
}

.dot {
  width: 8px;
  height: 8px;
  flex: none;
  align-self: center;
  background: var(--dim);
}

.st-kdf { stroke: #93c572; background: #93c572; }
.st-payload { stroke: #6ba292; background: #6ba292; }
.st-pixels { stroke: #d8b26a; background: #d8b26a; }
.st-output { stroke: #8a86b8; background: #8a86b8; }
.st-overhead { stroke: #46543d; background: #46543d; }

.lg-name { color: var(--fg); }
.lg-val { color: var(--fg); min-width: 38px; text-align: right; }
.lg-ms { color: var(--dim); min-width: 62px; text-align: right; margin-left: auto; }

.rows {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.row-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.st-mark { flex: none; }
.st-mark.ok { color: var(--acc); }
.st-mark.bad { color: var(--warn); }

.row-name {
  flex: 0 1 220px;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-bar {
  flex: 1;
  height: 6px;
  background: var(--sunken);
  border: 1px solid var(--line);
}

.row-bar i {
  display: block;
  height: 100%;
  background: var(--acc);
  opacity: 0.75;
}

.row-bar i.off {
  background: var(--warn);
  opacity: 0.4;
}

.row-share {
  flex: none;
  width: 44px;
  text-align: right;
  color: var(--dim);
}

.row-ms {
  flex: none;
  width: 68px;
  text-align: right;
  color: var(--fg);
}

.stats-empty {
  padding: 24px 16px;
  color: var(--dim);
  font-size: 12px;
}
</style>
