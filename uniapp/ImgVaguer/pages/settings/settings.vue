<script setup lang="ts">
/**
 * 设置页：独立页面而非页内浮层。
 * 内容走原生页面滚动、输入框处于常规文档流——各端均可正常聚焦；
 * 页面栈天然隔离，背景页面不会跟随滚动或响应操作。
 */
import DocsPanel from '@/components/DocsPanel.vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import { clearDefaultCover, pickDefaultCover } from '@/services/actions';
// #ifdef APP-PLUS
import { pickAppDirectory } from '@/services/platform/app-storage';
import { log } from '@/stores/session';
// #endif
// #ifndef H5
import { canvasBox } from '@/services/platform/canvas-box';
// #endif
import { topInset } from '@/services/platform/system';
import {
  applyDefaultPassword,
  clampCovers,
  clampTargets,
  COVER_MAX,
  COVER_MIN,
  saveSettings,
  settings,
  TARGET_MAX,
  TARGET_MIN,
} from '@/stores/session';
import { nextTick, onMounted, ref } from 'vue';

// #ifdef APP-PLUS
/**
 * 存储位置：经「打开方式」进入文件夹选择器自选目录（授权持久化）。
 * 失败/取消一律给出提示并记日志，避免出现「点了没反应」的错觉。
 */
async function chooseExportDir(): Promise<void> {
  const picked = await pickAppDirectory();
  if (!picked.ok || !picked.tree) {
    log(`未设置存储位置：${picked.message}`);
    uni.showToast({ title: picked.message, icon: 'none', duration: 2600 });
    return;
  }
  settings.exportTree = picked.tree;
  saveSettings();
  log(`存储位置已设为 ${picked.tree.path}`);
  uni.showToast({ title: `存储位置：${picked.tree.name}`, icon: 'none', duration: 2200 });
}
// #endif

/** 顶部安全距离：自定义导航下按状态栏高度下移（H5 为 0；挂载后再取一次以等 plus 就绪） */
const padTop = ref(topInset());
/** 固定顶栏高度：页面据此留白 */
const headHeight = ref(0);

function measureHead(): void {
  uni
    .createSelectorQuery()
    .select('.head')
    .boundingClientRect((rect: { height?: number } | null) => {
      if (rect && rect.height) headHeight.value = Math.ceil(rect.height);
    })
    .exec();
}

const password = ref('');
const maxMB = ref(settings.defaultCoverMaxMB);
const layers = ref(settings.maxCoverLayers);
const targets = ref(settings.maxTargets);
/** 像素上限以「万像素」编辑，落库仍为像素数 */
const pixels = ref(Math.round(settings.maxPixels / 10000));

const showDocs = ref(false);

/** 进入页面时同步一次本地编辑值，避免上次未提交的残留 */
function sync(): void {
  password.value = settings.defaultPassword;
  maxMB.value = settings.defaultCoverMaxMB;
  layers.value = settings.maxCoverLayers;
  targets.value = settings.maxTargets;
  pixels.value = Math.round(settings.maxPixels / 10000);
}

onMounted(() => {
  padTop.value = topInset();
  sync();
  nextTick(measureHead);
});

function back(): void {
  // 直接进入（如 H5 刷新该页）时无上级页面，回退到工作台
  uni.navigateBack({ delta: 1, fail: () => uni.reLaunch({ url: '/pages/index/index' }) });
}

function openDocs(): void {
  showDocs.value = true;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function stepMaxMB(d: number): void {
  maxMB.value = clamp(Math.round((maxMB.value + d) * 10) / 10, 0.5, 50);
  settings.defaultCoverMaxMB = maxMB.value;
  saveSettings();
}

function stepLayers(d: number): void {
  layers.value = clampCovers(layers.value + d);
  settings.maxCoverLayers = layers.value;
  saveSettings();
}

function stepTargets(d: number): void {
  targets.value = clampTargets(targets.value + d);
  settings.maxTargets = targets.value;
  saveSettings();
}

/** 像素上限按「千万像素」档调节：逐万调整要按上百次才挪得动 */
function stepPixels(d: number): void {
  pixels.value = Math.round(clamp(pixels.value + d, 1000, 6000));
  settings.maxPixels = pixels.value * 10000;
  saveSettings();
}

/** 仅记录默认口令；当前处于口令模式且输入框为空时补全，不改变保护方式 */
function commitPassword(): void {
  settings.defaultPassword = password.value;
  applyDefaultPassword();
  saveSettings();
}
</script>

<template>
  <!-- 文档面板为整屏浮层，遮罩本身即拦截交互；不再用 page-meta 锁滚动：
       实测关闭后页面滚动无法恢复，得不偿失 -->
  <view class="page" :style="{ paddingTop: headHeight + 'px' }">
    <view class="head" :style="{ paddingTop: padTop + 12 + 'px' }">
      <text class="title">─ 设置</text>
      <text class="close" @click="back">×</text>
    </view>

    <view class="sec">
      <text class="label">记忆</text>
      <view class="row">
        <text class="hint">记住参数调节（保存于本机）</text>
        <ToggleSwitch v-model="settings.rememberParams" @update:model-value="saveSettings" />
      </view>
    </view>

    <view class="sec">
      <text class="label">默认口令</text>
      <input
        v-model="password"
        class="input"
        :password="true"
        :cursor-spacing="24"
        placeholder="留空则不设置"
        placeholder-class="ph"
        @blur="commitPassword"
      />
      <text class="warn">⚠ 明文存于本机存储，公共设备勿用。</text>
    </view>

    <view class="sec">
      <text class="label">默认混淆图（下次启动载入）</text>
      <view class="row">
        <text class="value">{{ settings.defaultCover?.name ?? '未设置' }}</text>
        <text class="act" @click="pickDefaultCover">选择</text>
        <text v-if="settings.defaultCover" class="act del" @click="clearDefaultCover">清除</text>
      </view>
      <view class="row">
        <text class="hint">大小上限</text>
        <view class="stepper push">
          <text class="sbtn" @click="stepMaxMB(-0.5)">−</text>
          <text class="sval">{{ maxMB }}MB</text>
          <text class="sbtn" @click="stepMaxMB(0.5)">＋</text>
        </view>
      </view>
      <text class="hint">超过上限的图像将被拒绝并提示。</text>
    </view>

    <view class="sec">
      <text class="label">混淆图层上限</text>
      <view class="row">
        <view class="stepper">
          <text class="sbtn" @click="stepLayers(-1)">−</text>
          <text class="sval">{{ layers }} 层</text>
          <text class="sbtn" @click="stepLayers(1)">＋</text>
        </view>
        <text class="hint tip">{{ COVER_MIN }}–{{ COVER_MAX }} 层</text>
      </view>
    </view>

    <view class="sec">
      <text class="label">批量上限</text>
      <view class="row">
        <text class="hint">目标图数量</text>
        <view class="stepper push">
          <text class="sbtn" @click="stepTargets(-1)">−</text>
          <text class="sval">{{ targets }} 张</text>
          <text class="sbtn" @click="stepTargets(1)">＋</text>
        </view>
      </view>
      <text class="hint">{{ TARGET_MIN }}–{{ TARGET_MAX }} 张</text>
      <view class="row">
        <text class="hint">单张像素上限</text>
        <view class="stepper push">
          <text class="sbtn" @click="stepPixels(-1000)">−</text>
          <text class="sval">{{ pixels }} 万</text>
          <text class="sbtn" @click="stepPixels(1000)">＋</text>
        </view>
      </view>
      <text class="hint">合并张数越多，输出体积越接近各原文件之和；像素上限用于挡掉一解码就耗尽内存的巨图。</text>
    </view>

    <view class="sec">
      <text class="label">帮助</text>
      <view class="row">
        <text class="act" @click="openDocs">[ 打开使用文档 ]</text>
      </view>
    </view>

    <!-- #ifdef APP-PLUS -->
    <view class="sec">
      <text class="label">存储位置</text>
      <view class="row">
        <text class="value">{{ settings.exportTree?.name ?? '未选择' }}</text>
        <text class="act" @click="chooseExportDir">选择文件夹</text>
      </view>
      <text class="hint">{{ settings.exportTree?.path ?? '导出文件将保存到所选文件夹（首次导出时也会提示选择）' }}</text>
    </view>
    <!-- #endif -->

    <view class="foot">
      <text class="btn" @click="back">[ 返回 ]</text>
    </view>

    <DocsPanel :visible="showDocs" @close="showDocs = false" />

    <!-- App / 小程序：默认混淆图解码用的隐藏画布 -->
    <!-- #ifndef H5 -->
    <canvas
      canvas-id="vg-canvas"
      class="vg-canvas"
      :style="{ width: canvasBox.width + 'px', height: canvasBox.height + 'px' }"
    />
    <!-- #endif -->
  </view>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: var(--bg);
  padding-bottom: calc(32rpx + env(safe-area-inset-bottom));
}
/* 固定顶栏：不随页面滚动移动（页面据 headHeight 留白） */
.head {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  /* 顶部内边距由状态栏高度动态给出（见模板 :style） */
  padding: 20rpx 24rpx;
  border-bottom: 1rpx solid var(--line);
  background: var(--panel);
}
.title {
  color: var(--acc);
  font-size: 26rpx;
}
.close {
  flex: none;
  margin-left: auto;
  color: var(--dim);
  font-size: 34rpx;
  line-height: 1;
  padding: 0 8rpx;
}
.sec {
  border: 1rpx solid var(--line);
  background: var(--panel);
  margin: 20rpx 24rpx 0;
  padding: 20rpx 24rpx;
}
.label {
  color: var(--acc);
  font-size: 26rpx;
}
.row {
  display: flex;
  align-items: center;
  margin-top: 14rpx;
}
.hint {
  flex: 1;
  min-width: 0;
  color: var(--dim);
  font-size: 22rpx;
}
/* 与左侧控件保持间距的两处修饰类 */
.hint.tip {
  margin-left: 20rpx;
}
.stepper.push {
  margin-left: 20rpx;
}
.value {
  flex: 1;
  min-width: 0;
  color: var(--fg);
  font-size: 24rpx;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* 操作文字固定不压缩，并与右侧边界留出间距 */
.act {
  flex: none;
  color: var(--acc);
  font-size: 24rpx;
  border: 1rpx solid var(--line-hi);
  padding: 8rpx 24rpx;
  margin-left: 20rpx;
}
.act.del {
  color: var(--err);
  border-color: var(--line);
}
.input {
  margin-top: 14rpx;
  border: 1rpx solid var(--line);
  background: var(--sunken);
  color: var(--fg);
  padding: 16rpx;
  font-size: 26rpx;
}
.warn {
  display: block;
  margin-top: 10rpx;
  color: var(--warn);
  font-size: 22rpx;
}
.stepper {
  display: flex;
  align-items: center;
  border: 1rpx solid var(--line);
  flex: none;
}
.sbtn {
  width: 68rpx;
  text-align: center;
  padding: 10rpx 0;
  color: var(--acc);
  font-size: 30rpx;
}
.sval {
  min-width: 150rpx;
  text-align: center;
  color: var(--fg);
  font-size: 24rpx;
  padding: 0 8rpx;
  border-left: 1rpx solid var(--line);
  border-right: 1rpx solid var(--line);
}
.foot {
  margin: 24rpx 24rpx 0;
}

.btn {
  display: block;
  text-align: center;
  border: 1rpx solid var(--line-hi);
  color: var(--acc);
  padding: 22rpx 0;
  font-size: 26rpx;
  background: var(--panel);
}
.ph {
  color: var(--line-hi);
}
/* 隐藏解码画布：移出可视区但保持渲染 */
.vg-canvas {
  position: fixed;
  left: -10000px;
  top: 0;
  z-index: -1;
}
</style>
