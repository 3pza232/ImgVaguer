<script setup lang="ts">
/** 缩略图条：已选图像列表 + 追加入口；图层模式额外提供层序调整 */
interface StripItem {
  src: string;
  name: string;
}

withDefaults(
  defineProps<{
    items: StripItem[];
    addLabel?: string;
    /** 层序调整（混淆图层用 ↑↓ 替代桌面拖拽） */
    orderable?: boolean;
    showIndex?: boolean;
  }>(),
  { addLabel: '添加', orderable: false, showIndex: false },
);

const emit = defineEmits<{
  (e: 'add'): void;
  (e: 'remove', index: number): void;
  (e: 'move', from: number, to: number): void;
  (e: 'preview', index: number): void;
}>();
</script>

<template>
  <view class="strip">
    <scroll-view class="scroll" scroll-x :show-scrollbar="false">
      <view class="row">
        <view v-for="(it, i) in items" :key="it.name + i" class="cell">
          <view class="frame" @click="emit('preview', i)">
            <image class="pic" :src="it.src" mode="aspectFill" />
            <text class="x" @click.stop="emit('remove', i)">×</text>
            <text v-if="showIndex" class="idx">L{{ i + 1 }}</text>
          </view>
          <view v-if="orderable" class="ops">
            <text class="op" :class="{ off: i === 0 }" @click.stop="emit('move', i, i - 1)">↑</text>
            <text class="op" :class="{ off: i === items.length - 1 }" @click.stop="emit('move', i, i + 1)">↓</text>
          </view>
        </view>
        <view class="cell">
          <view class="add" @click="emit('add')">
            <text class="plus">＋</text>
            <text class="add-label">{{ addLabel }}</text>
          </view>
        </view>
      </view>
    </scroll-view>
  </view>
</template>

<style scoped>
.scroll {
  width: 100%;
  white-space: nowrap;
}
.row {
  display: flex;
  align-items: flex-start;
}
/* flex: none 防止横向滚动时被压缩（否则缩略图会被挤扁、滚动失效） */
.cell {
  flex: none;
  margin-right: 16rpx;
}
.frame {
  position: relative;
  width: 152rpx;
  height: 152rpx;
  border: 1rpx solid var(--line-hi);
  background: var(--sunken);
}
.pic {
  width: 100%;
  height: 100%;
}
.x {
  position: absolute;
  top: 0;
  right: 0;
  width: 44rpx;
  height: 44rpx;
  line-height: 44rpx;
  text-align: center;
  color: var(--err);
  background: rgba(11, 14, 11, 0.82);
}
.idx {
  position: absolute;
  left: 0;
  bottom: 0;
  padding: 0 8rpx;
  font-size: 20rpx;
  color: var(--acc);
  background: rgba(11, 14, 11, 0.82);
}
.ops {
  display: flex;
  margin-top: 6rpx;
  border: 1rpx solid var(--line);
}
.op {
  flex: 1;
  text-align: center;
  padding: 8rpx 0;
  color: var(--acc);
  font-size: 26rpx;
}
.op.off {
  color: var(--line-hi);
}
.add {
  width: 152rpx;
  height: 152rpx;
  border: 1rpx dashed var(--line-hi);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.plus {
  color: var(--acc);
  font-size: 40rpx;
  line-height: 1;
}
.add-label {
  margin-top: 8rpx;
  color: var(--dim);
  font-size: 22rpx;
}
</style>
