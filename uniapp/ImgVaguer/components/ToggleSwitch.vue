<script setup lang="ts">
/**
 * TUI 开关：直角细框 + 方形滑块，替代原生 switch
 * （原生开关在 H5/小程序风格与主题不一，且尺寸偏大）。
 */
withDefaults(defineProps<{ modelValue: boolean; disabled?: boolean }>(), { disabled: false });
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();
</script>

<template>
  <view
    class="toggle"
    :class="{ on: modelValue, disabled }"
    @click="disabled ? null : emit('update:modelValue', !modelValue)"
  >
    <view class="knob" />
  </view>
</template>

<style scoped>
.toggle {
  position: relative;
  width: 78rpx;
  height: 44rpx;
  border: 1rpx solid var(--line-hi);
  background: var(--sunken);
  flex: none;
}
.toggle.on {
  border-color: var(--acc);
}
.knob {
  position: absolute;
  top: 3rpx;
  left: 3rpx;
  width: 36rpx;
  height: 36rpx;
  background: var(--line-hi);
  transition: left 0.15s ease-out, background 0.15s ease-out;
}
.toggle.on .knob {
  left: 39rpx;
  background: var(--acc);
}
.toggle.disabled {
  opacity: 0.45;
}
</style>
