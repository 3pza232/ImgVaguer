<script setup lang="ts">
/**
 * 堆叠预览：滑动切换图集（替代桌面滚轮/箭头），点按系统级放大。
 * INPUT/OUTPUT 角标可点按切换；覆盖合成时左下角以 PiP 显示混淆图层。
 */
import { openZoom } from '@/stores/zoom';
import { computed, ref, watch } from 'vue';

interface PreviewImage {
  src: string;
  name: string;
}

const props = withDefaults(
  defineProps<{
    inputImages: PreviewImage[];
    outputImages: PreviewImage[];
    covers?: PreviewImage[];
    /** 由外部驱动切换图集（如执行完成自动切到 OUTPUT） */
    activeSide?: 'input' | 'output';
  }>(),
  { covers: () => [], activeSide: 'input' },
);

const side = ref<'input' | 'output'>(props.activeSide);
const index = ref(0);
const coverIndex = ref(0);

// 注意：watch 的取值函数会在创建时立即求值，被引用的变量必须先声明
const list = computed<PreviewImage[]>(() => (side.value === 'input' ? props.inputImages : props.outputImages));
const current = computed(() => list.value[index.value] ?? null);
const currentCover = computed(() => props.covers[coverIndex.value] ?? null);

watch(
  () => props.activeSide,
  (v) => {
    side.value = v;
    index.value = 0;
  },
);

/** 列表缩短时收敛索引：正在查看的图被删除则退到上一张，无剩余则显示空态 */
function clampIndex(total: number, current: { value: number }): void {
  if (total === 0) current.value = 0;
  else if (current.value > total - 1) current.value = total - 1;
}

watch(() => list.value.length, (n) => clampIndex(n, index));
watch(() => props.covers.length, (n) => clampIndex(n, coverIndex));

function switchSide(next: 'input' | 'output'): void {
  side.value = next;
  index.value = 0;
}

function onSwiperChange(e: { detail: { current: number } }): void {
  index.value = e.detail.current;
}

function onCoverChange(e: { detail: { current: number } }): void {
  coverIndex.value = e.detail.current;
}

/** 放大预览：交给应用内主题化浮层（系统 previewImage 传 data URL 会崩溃） */
function preview(shots: PreviewImage[], at: number): void {
  openZoom(shots.map((s) => s.src), at);
}

function previewMain(): void {
  preview(list.value, index.value);
}

function previewCover(): void {
  preview(props.covers, coverIndex.value);
}
</script>

<template>
  <view class="preview">
    <view class="stage">
      <view class="tags">
        <text class="tag" :class="{ on: side === 'input' }" @click="switchSide('input')">INPUT</text>
        <text class="tag" :class="{ on: side === 'output' }" @click="switchSide('output')">OUTPUT</text>
        <text v-if="list.length > 1" class="count">{{ index + 1 }}/{{ list.length }}</text>
      </view>

      <view v-if="current" class="frame" @click="previewMain">
        <swiper
          :key="`${side}-${list.length}`"
          class="swiper"
          :current="index"
          :circular="list.length > 1"
          @change="onSwiperChange"
        >
          <swiper-item v-for="(img, i) in list" :key="img.name + i">
            <image class="shot" :src="img.src" mode="aspectFit" />
          </swiper-item>
        </swiper>
        <text class="caption" :class="{ 'with-pip': covers.length > 0 }">{{ current.name }}</text>
      </view>
      <view v-else class="empty">
        <text class="empty-mark">∅ 无图像</text>
      </view>

      <view v-if="currentCover" class="pip" @click.stop="previewCover">
        <text class="pip-tag">COVER {{ coverIndex + 1 }}/{{ covers.length }}</text>
        <swiper :key="`cover-${covers.length}`" class="pip-swiper" :current="coverIndex" @change="onCoverChange">
          <swiper-item v-for="(c, i) in covers" :key="c.name + i">
            <image class="pip-shot" :src="c.src" mode="aspectFill" />
          </swiper-item>
        </swiper>
      </view>
    </view>
  </view>
</template>

<style scoped>
.stage {
  position: relative;
  border: 1rpx solid var(--line);
  background: var(--sunken);
  height: 56vw;
  min-height: 420rpx;
}
.tags {
  position: absolute;
  top: 12rpx;
  left: 12rpx;
  z-index: 3;
  display: flex;
  align-items: center;
}
.tag {
  font-size: 22rpx;
  color: var(--dim);
  border: 1rpx solid var(--line);
  padding: 2rpx 12rpx;
  margin-right: 8rpx;
  background: rgba(11, 14, 11, 0.8);
}
.tag.on {
  color: var(--acc);
  border-color: var(--acc);
}
.count {
  font-size: 22rpx;
  color: var(--dim);
  background: rgba(11, 14, 11, 0.8);
  padding: 2rpx 10rpx;
}
.frame {
  width: 100%;
  height: 100%;
}
.swiper {
  width: 100%;
  height: 100%;
}
.shot {
  width: 100%;
  height: 100%;
}
.caption {
  position: absolute;
  bottom: 12rpx;
  left: 12rpx;
  right: 12rpx;
  font-size: 22rpx;
  color: var(--dim);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  background: rgba(11, 14, 11, 0.8);
}
/* COVER 小窗占据左下角，说明文字顺延 */
.caption.with-pip {
  left: 232rpx;
}
.empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.empty-mark {
  color: var(--dim);
  font-size: 26rpx;
}
.pip {
  position: absolute;
  left: 12rpx;
  bottom: 12rpx;
  z-index: 4;
  width: 200rpx;
  height: 200rpx;
  border: 1rpx solid var(--acc);
  background: var(--sunken);
}
.pip-tag {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  font-size: 18rpx;
  color: var(--acc);
  background: rgba(11, 14, 11, 0.85);
  padding: 0 6rpx;
}
.pip-swiper {
  width: 100%;
  height: 100%;
}
.pip-shot {
  width: 100%;
  height: 100%;
}
</style>
