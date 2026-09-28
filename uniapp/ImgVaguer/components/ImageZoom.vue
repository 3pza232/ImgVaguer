<script setup lang="ts">
/** 放大预览浮层：左右滑动切换、点空白关闭；主题化，替代系统 previewImage */
import { closeZoom, zoom } from '@/stores/zoom';

function onChange(e: { detail: { current: number } }): void {
  zoom.index = e.detail.current;
}
</script>

<template>
  <view v-if="zoom.open" class="zoom" @click="closeZoom">
    <swiper class="stage" :current="zoom.index" :circular="zoom.urls.length > 1" @change="onChange">
      <swiper-item v-for="(url, i) in zoom.urls" :key="i">
        <image class="pic" :src="url" mode="aspectFit" />
      </swiper-item>
    </swiper>
    <text class="count">{{ zoom.index + 1 }}/{{ zoom.urls.length }}</text>
    <text class="close" @click.stop="closeZoom">×</text>
  </view>
</template>

<style scoped>
.zoom {
  position: fixed;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 80;
  background: rgba(5, 7, 5, 0.95);
  display: flex;
  align-items: center;
  justify-content: center;
}
.stage {
  width: 100%;
  height: 100%;
}
.pic {
  width: 100%;
  height: 100%;
}
.count {
  position: absolute;
  bottom: calc(28rpx + env(safe-area-inset-bottom));
  left: 0;
  right: 0;
  text-align: center;
  color: var(--dim);
  font-size: 24rpx;
}
.close {
  position: absolute;
  top: 60rpx;
  right: 24rpx;
  color: var(--dim);
  font-size: 44rpx;
  line-height: 1;
  padding: 0 16rpx;
}
</style>
