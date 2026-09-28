<script setup lang="ts">
/**
 * 工作台：单页完成加解密闭环。
 * 布局顺序 = 拇指可达顺序：操作页签 → 预览 → 选图 → 方式/保护/参数 → 结果日志 → 底部执行。
 */
import { APP_AUTHOR, APP_VERSION } from '@/app-meta';
import CollapseSection from '@/components/CollapseSection.vue';
import ImageZoom from '@/components/ImageZoom.vue';
import LogDrawer from '@/components/LogDrawer.vue';
import SegBar from '@/components/SegBar.vue';
import StackPreview from '@/components/StackPreview.vue';
import ThumbStrip from '@/components/ThumbStrip.vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import {
  applyDefaultCover,
  exportKey,
  pickCovers,
  pickKeyFile,
  pickTargets,
  run,
  saveAll,
  saveResult,
} from '@/services/actions';
// #ifdef APP-PLUS
import { copyKey, pickKeyFromSystem } from '@/services/actions';
import { pickAppDirectory } from '@/services/platform/app-storage';
// #endif
// #ifndef H5
import { canvasBox } from '@/services/platform/canvas-box';
// #endif
import { topInset } from '@/services/platform/system';
import {
  clearCovers,
  clearKeyFile,
  clearTargets,
  log,
  moveCover,
  removeBatch,
  removeCover,
  removeTarget,
  settings,
  stepBatch,
  store,
} from '@/stores/session';
// #ifdef APP-PLUS
import { saveSettings } from '@/stores/session';
// #endif
import { openZoom } from '@/stores/zoom';
import { computed, nextTick, onMounted, ref, watch } from 'vue';

/** 结果产生后自动切到 OUTPUT，减少一次手动点击 */
const activeSide = ref<'input' | 'output'>('input');

/** 顶部安全距离：自定义导航下按状态栏高度下移（H5 为 0；挂载后再取一次以等 plus 就绪） */
const padTop = ref(topInset());
/** 固定顶栏高度：内容据此留白，避免被遮挡 */
const navHeight = ref(0);

function measureNav(): void {
  uni
    .createSelectorQuery()
    .select('.nav')
    .boundingClientRect((rect: { height?: number } | null) => {
      if (rect && rect.height) navHeight.value = Math.ceil(rect.height);
    })
    .exec();
}

/**
 * 随机源桥触发计数：挂载与切换操作模式时各触发一次（渲染层据此回传随机字节）。
 * renderjs 回传方法（onRenderRandom）见文件底部普通 <script>：
 * callMethod 走 options API 的 methods，不识别 <script setup> 的 defineExpose。
 */
const rngSeed = ref(0);
watch(
  () => store.op,
  () => {
    rngSeed.value += 1;
  },
);

const opOptions = [
  { value: 'encrypt', label: '加密' },
  { value: 'decrypt', label: '解密' },
];
const modeOptions = [
  { value: 'scramble', label: '密文混淆' },
  { value: 'overlay', label: '覆盖合成' },
];
const protectOptions = [
  { value: 'none', label: '无' },
  { value: 'password', label: '口令' },
  { value: 'keyfile', label: '密钥文件' },
];

const batch = computed(() => store.batches[store.batchIndex] ?? null);
const okCount = computed(() => batch.value?.items.filter((i) => i.ok).length ?? 0);

// #ifdef APP-PLUS
/** 密钥另存面板：文件名由用户给定，不追加后缀 */
const keySaveOpen = ref(false);
const keySaveName = ref('imgvaguer-key.ivkey');
const keyText = computed(() => batch.value?.keyFile?.text ?? '');

/**
 * 存储位置未选择时，先让用户在系统文件管理器里挑一个文件夹（授权持久化），
 * 选定后自动继续原导出动作；用户取消则中止本次导出。
 */
async function ensureDir(retry: () => Promise<void>): Promise<void> {
  if (settings.exportTree) {
    await retry();
    return;
  }
  uni.showToast({ title: '请选择导出文件夹', icon: 'none', duration: 1800 });
  const picked = await pickAppDirectory();
  if (!picked.ok || !picked.tree) {
    log(`未设置存储位置：${picked.message}`);
    uni.showToast({ title: picked.message, icon: 'none', duration: 2600 });
    return;
  }
  settings.exportTree = picked.tree;
  saveSettings();
  log(`存储位置已设为 ${picked.tree.name}`);
  await retry();
}

async function onSaveKey(): Promise<void> {
  if (!keyText.value) return;
  keySaveOpen.value = false;
  await ensureDir(() => exportKey(keySaveName.value.trim() || 'imgvaguer-key.ivkey'));
}

/** 单张导出：存储位置未选择时先引导选择 */
function onSaveResult(item: { bytes: Uint8Array | null; name: string }): void {
  void ensureDir(async () => void saveResult(item as never));
}
// #endif

/** 选图：直接进系统相册（App / 小程序）或文件选择器（H5），不再弹来源面板 */
function onPickImages(): void {
  void pickTargets();
}

function onKeyExport(): void {
  // #ifdef APP-PLUS
  if (!keyText.value) return;
  keySaveName.value = batch.value?.keyFile?.name ?? 'imgvaguer-key.ivkey';
  keySaveOpen.value = true;
  return;
  // #endif
  exportKey();
}

/** 全部导出：写入「存储位置/ImgVaguer」；若该批含密钥文件，随后弹出另存面板 */
async function onExportAll(): Promise<void> {
  if (!okCount.value || store.busy) return;
  // #ifdef APP-PLUS
  await ensureDir(async () => {
    await saveAll();
    if (batch.value?.keyFile) {
      keySaveName.value = batch.value.keyFile.name;
      keySaveOpen.value = true;
    }
  });
  return;
  // #endif
  // #ifndef APP-PLUS
  await saveAll();
  // #endif
}

/**
 * 结果区高度策略：行数未超上限时随内容自适应，超出后给定固定高度并区内滚动。
 * uni 的 scroll-view 竖向滚动必须给定 height（max-height 不足以成立），
 * 故此处按行高估算切换，避免真实测量带来的异步复杂度。
 */
const RES_ROW_H = 116;
const RES_MAX_H = 760;

const resStyle = computed(() => {
  const b = batch.value;
  if (!b) return {};
  const rows = b.items.length + (b.keyFile ? 1 : 0);
  return rows * RES_ROW_H > RES_MAX_H ? { height: `${RES_MAX_H}rpx` } : {};
});

/** 缩略图条用（小图，列表滚动轻量） */
const inputThumbs = computed(() => store.targets.map((t) => ({ src: t.thumb, name: t.name })));
const coverThumbs = computed(() =>
  store.op === 'encrypt' && store.mode === 'overlay'
    ? store.covers.map((c) => ({ src: c.thumb, name: c.name }))
    : [],
);
/** 堆叠预览与放大用（大图，避免放大发糊） */
const inputImages = computed(() => store.targets.map((t) => ({ src: t.preview, name: t.name })));
const coverImages = computed(() =>
  store.op === 'encrypt' && store.mode === 'overlay'
    ? store.covers.map((c) => ({ src: c.preview, name: c.name }))
    : [],
);
const outputImages = computed(() =>
  (batch.value?.items ?? []).filter((i) => i.ok).map((i) => ({ src: i.preview, name: i.name })),
);

const showCovers = computed(() => store.op === 'encrypt' && store.mode === 'overlay');
const execLabel = computed(() => (store.op === 'encrypt' ? '[ 执行加密 ]' : '[ 执行解密 ]'));
/** 高迭代提示阈值（纯 TS 派生路径下耗时明显） */
const KDF_WARN = 1000000;

/** 层位选项：自上而下层号（第 1 层=顶层） */
const layerOptions = computed(() =>
  Array.from({ length: store.covers.length + 1 }, (_, i) => ({
    pos: i + 1,
    value: store.covers.length - i,
    label:
      i === 0
        ? `第 1 层（顶层）`
        : i === store.covers.length
          ? `第 ${i + 1} 层（底层）`
          : `第 ${i + 1} 层`,
  })),
);

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function onSliderValue(e: { detail: { value: number } }): number {
  return e.detail.value;
}

async function execute(): Promise<void> {
  activeSide.value = 'input';
  try {
    await run();
  } catch (e) {
    const msg = (e as Error).message || '执行失败';
    log(`执行失败: ${msg}`);
    uni.showToast({ title: msg, icon: 'none', duration: 3000 });
    return;
  }
  if (okCount.value > 0) {
    activeSide.value = 'output';
    scrollToResults();
  }
}

/** 结果产生后滚动到结果区，避免用户误以为没有输出 */
function scrollToResults(): void {
  try {
    uni.pageScrollTo({ selector: '#results', duration: 300, fail: () => undefined });
  } catch {
    // 部分平台不支持选择器定位，忽略
  }
}

/** 设置与文档均为独立页面：页面栈天然隔离，背景不参与滚动与操作 */
function openSettings(): void {
  uni.navigateTo({ url: '/pages/settings/settings' });
}

function previewMain(index: number): void {
  openZoom(inputImages.value.map((i) => i.src), index);
}

function previewCovers(index: number): void {
  openZoom(coverImages.value.map((c) => c.src), index);
}

/** 层序调整：操作后给一次轻震动反馈（H5 等不支持时静默忽略） */
function onMoveCover(from: number, to: number): void {
  moveCover(from, to);
  uni.vibrateShort({ fail: () => undefined });
}

/** 结果缩略图放大预览：以 OUTPUT 图集为序列，可左右滑动查看全部结果 */
function previewResult(index: number): void {
  const urls = outputImages.value.map((o) => o.src);
  if (!urls.length) return;
  // 失败项不进 OUTPUT 图集，需按成功项在前缀中的数量折算索引
  const at = (batch.value?.items ?? []).slice(0, index).filter((x) => x.ok && x.preview).length;
  openZoom(urls, Math.min(at, urls.length - 1));
}

onMounted(() => {
  // 随机源提供者由 App.vue 的 onLaunch 安装；此处触发渲染层回传随机字节
  padTop.value = topInset();
  rngSeed.value = 1;
  void applyDefaultCover();
  nextTick(measureNav);
});
</script>

<script lang="ts">
import { fromBase64 } from '@/core/base64';
import { feedRandom } from '@/services/platform/random-pool';

/**
 * renderjs 回调用方法必须挂在组件实例的 methods 上（ownerInstance.callMethod 走
 * options API，不识别 <script setup> 的 defineExpose），故单独用普通 <script> 声明。
 */
export default {
  methods: {
    /** 渲染层回传的随机字节（base64）：App 逻辑层无 Web Crypto，靠渲染层注入 */
    onRenderRandom(b64: string): void {
      feedRandom(fromBase64(b64));
    },
  },
};
</script>

<!-- App 端随机源：逻辑层无 crypto，改为在渲染层取随机并回传 -->
<!-- #ifdef APP-PLUS -->
<script module="vgrng" lang="renderjs">
export default {
  methods: {
    arm(_value, _old, ownerInstance) {
      const c = window.crypto || window.msCrypto;
      if (!c || typeof c.getRandomValues !== 'function') return;
      const buf = new Uint8Array(4096);
      c.getRandomValues(buf);
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      ownerInstance.callMethod('onRenderRandom', btoa(bin));
    },
  },
};
</script>
<!-- #endif -->



<template>
  <view class="page">
    <!-- 自定义导航（沉浸深色） -->
    <view class="nav" :style="{ paddingTop: padTop + 12 + 'px' }">
      <text class="brand">█ ImgVaguer</text>
      <text class="meta">v{{ APP_VERSION }} [by {{ APP_AUTHOR }}]</text>
      <text class="gear" @click="openSettings">⚙</text>
    </view>

    <view class="content" :style="{ paddingTop: navHeight + 'px' }">
      <SegBar v-model="store.op" :options="opOptions" />

      <view class="block">
        <StackPreview
          :input-images="inputImages"
          :output-images="outputImages"
          :covers="coverImages"
          :active-side="activeSide"
        />
      </view>

      <!-- 输入 -->
      <view class="block">
        <view class="title">─ 输入</view>
        <ThumbStrip
          :items="inputThumbs"
          :add-label="store.op === 'encrypt' ? '选图' : '选密文图'"
          @add="onPickImages"
          @remove="removeTarget"
          @preview="previewMain"
        />
        <view v-if="store.targets.length" class="row-between">
          <text class="hint">共 {{ store.targets.length }} 张</text>
          <text class="link" @click="clearTargets">清空</text>
        </view>
        <view v-if="store.op === 'encrypt'" class="row-between">
          <text class="hint">多图合并为一张（解密还原全部原图）</text>
          <ToggleSwitch v-model="store.pack" />
        </view>
      </view>

      <!-- 混淆图层 -->
      <view v-if="showCovers" class="block">
        <view class="title">─ 混淆图层</view>
        <ThumbStrip
          :items="coverThumbs"
          add-label="加图层"
          orderable
          show-index
          @add="pickCovers"
          @remove="removeCover"
          @move="onMoveCover"
          @preview="previewCovers"
        />
        <view v-if="store.covers.length" class="row-between">
          <text class="hint">共 {{ store.covers.length }}/{{ settings.maxCoverLayers }} 层</text>
          <text class="link" @click="clearCovers">清空</text>
        </view>
        <view v-if="store.covers.length" class="chips">
          <text class="chip-label">目标图所在层</text>
          <scroll-view class="chip-scroll" scroll-x :show-scrollbar="false">
            <view class="chip-row">
              <text
                v-for="o in layerOptions"
                :key="o.value"
                class="chip"
                :class="{ on: store.targetLayer === o.value }"
                @click="store.targetLayer = o.value"
              >
                {{ o.label }}
              </text>
            </view>
          </scroll-view>
        </view>
      </view>

      <!-- 混淆方式 -->
      <view v-if="store.op === 'encrypt'" class="block">
        <view class="title">─ 混淆方式</view>
        <SegBar v-model="store.mode" :options="modeOptions" />
      </view>

      <!-- 保护方式 / 凭据 -->
      <view class="block">
        <view class="title">{{ store.op === 'encrypt' ? '─ 保护方式' : '─ 凭据' }}</view>
        <template v-if="store.op === 'encrypt'">
          <SegBar v-model="store.protection" :options="protectOptions" />
          <input
            v-if="store.protection === 'password'"
            v-model="store.password"
            class="input"
            :password="true"
            :cursor-spacing="24"
            placeholder="输入口令"
            placeholder-class="ph"
          />
          <text v-else-if="store.protection === 'keyfile'" class="hint">
            加密后在结果区导出密钥，与图像分开保管。
          </text>
        </template>
        <template v-else>
          <input
            v-model="store.password"
            class="input"
            :password="true"
            :cursor-spacing="24"
            placeholder="口令保护的图像需填写"
            placeholder-class="ph"
          />
          <view class="row-between">
            <text class="hint">密钥：{{ store.keyFile?.name ?? '未载入' }}</text>
            <!-- #ifdef APP-PLUS -->
            <view class="link" hover-class="pressed" @click="pickKeyFromSystem">从文件载入</view>
            <view class="link" hover-class="pressed" @click="pickKeyFile">剪贴板</view>
            <!-- #endif -->
            <!-- #ifdef H5 -->
            <view class="link" hover-class="pressed" @click="pickKeyFile">{{ store.keyFile ? '更换' : '载入' }}</view>
            <!-- #endif -->
            <!-- #ifdef MP-WEIXIN -->
            <view class="link" hover-class="pressed" @click="pickKeyFile">剪贴板</view>
            <!-- #endif -->
            <view v-if="store.keyFile" class="link del" hover-class="pressed" @click="clearKeyFile">卸载</view>
          </view>
        </template>
      </view>

      <!-- 参数（仅加密）：解密所需参数随图像自动读取 -->
      <CollapseSection v-if="store.op === 'encrypt'" title="─ 参数" :summary="`迭代 ${(store.iterations / 10000).toFixed(0)} 万`">
        <view class="row-between">
          <text class="hint">KDF 迭代次数</text>
          <text class="val">{{ store.iterations.toLocaleString() }}</text>
        </view>
        <slider
          :value="store.iterations"
          :min="50000"
          :max="3000000"
          :step="50000"
          activeColor="#93c572"
          backgroundColor="#243020"
          block-size="20"
          @change="store.iterations = onSliderValue($event)"
        />
        <text v-if="store.iterations >= KDF_WARN" class="hint">高迭代会显著增加加密耗时。</text>

        <template v-if="store.mode === 'scramble'">
          <view class="row-between">
            <text class="hint">噪声强度</text>
            <text class="val">{{ store.noise }}</text>
          </view>
          <slider
            :value="store.noise"
            :min="0"
            :max="64"
            :step="1"
            activeColor="#93c572"
            backgroundColor="#243020"
            block-size="20"
            @change="store.noise = onSliderValue($event)"
          />
          <view class="row-between">
            <text class="hint">变换轮数</text>
            <text class="val">{{ store.rounds }}</text>
          </view>
          <slider
            :value="store.rounds"
            :min="1"
            :max="4"
            :step="1"
            activeColor="#93c572"
            backgroundColor="#243020"
            block-size="20"
            @change="store.rounds = onSliderValue($event)"
          />
          <view class="row-between">
            <text class="hint">分块尺寸</text>
            <view class="chips-inline">
              <text
                v-for="b in [8, 16, 32]"
                :key="b"
                class="chip"
                :class="{ on: store.blockSize === b }"
                @click="store.blockSize = b as 8 | 16 | 32"
              >
                {{ b }}px
              </text>
            </view>
          </view>
          <view class="row-between">
            <text class="hint">S 盒字节替换</text>
            <ToggleSwitch v-model="store.sbox" />
          </view>
          <view class="row-between">
            <text class="hint">行列循环移位</text>
            <ToggleSwitch v-model="store.rowshift" />
          </view>
          <view class="row-between">
            <text class="hint">全局像素置换（大图较慢）</text>
            <ToggleSwitch v-model="store.globalPerm" />
          </view>
        </template>

        <template v-else>
          <view class="row-between">
            <text class="hint">覆盖不透明度</text>
            <text class="val">{{ Math.round(store.opacity * 100) }}%</text>
          </view>
          <slider
            :value="store.opacity * 100"
            :min="50"
            :max="100"
            :step="5"
            activeColor="#93c572"
            backgroundColor="#243020"
            block-size="20"
            @change="store.opacity = onSliderValue($event) / 100"
          />
          <view class="row-between">
            <text class="hint">覆盖层压缩</text>
            <text class="val">{{ store.coverQuality >= 1 ? '关' : Math.round(store.coverQuality * 100) + '%' }}</text>
          </view>
          <slider
            :value="store.coverQuality * 100"
            :min="10"
            :max="100"
            :step="5"
            activeColor="#93c572"
            backgroundColor="#243020"
            block-size="20"
            @change="store.coverQuality = onSliderValue($event) / 100"
          />
          <view class="row-between">
            <text class="hint">混淆图适配</text>
            <view class="chips-inline">
              <text class="chip" :class="{ on: store.fit === 'cover' }" @click="store.fit = 'cover'">等比裁剪</text>
              <text class="chip" :class="{ on: store.fit === 'stretch' }" @click="store.fit = 'stretch'">拉伸</text>
            </view>
          </view>
        </template>
      </CollapseSection>

      <!-- 结果 -->
      <view v-if="batch" id="results" class="block">
        <view class="row-between">
          <text class="title">─ 结果（{{ okCount }} 张）</text>
          <view class="pager">
            <text class="pg" :class="{ off: store.batches.length < 2 }" @click="stepBatch(-1)">‹</text>
            <text class="pg-count">{{ store.batchIndex + 1 }}/{{ store.batches.length }}</text>
            <text class="pg" :class="{ off: store.batches.length < 2 }" @click="stepBatch(1)">›</text>
            <text class="link del" @click="removeBatch(store.batchIndex)">×</text>
          </view>
        </view>

        <!-- 结果列表：超过上限即内部滚动，「全部导出」恒定停靠区块底部 -->
        <scroll-view class="res-list" scroll-y :show-scrollbar="false" :style="resStyle">
          <view v-if="batch.keyFile" class="item key">
            <text class="mark ok">⚿</text>
            <text class="name">{{ batch.keyFile.name }}</text>
            <view class="act" hover-class="pressed" @click="onKeyExport">导出</view>
          </view>

          <view v-for="(r, i) in batch.items" :key="i" class="item">
            <text class="mark" :class="r.ok ? 'ok' : 'bad'">{{ r.ok ? '✓' : '✗' }}</text>
            <image
              v-if="r.ok && r.preview"
              class="thumb"
              :src="r.preview"
              mode="aspectFill"
              @click="previewResult(i)"
            />
            <view class="info">
              <text class="name">{{ r.name }}</text>
              <text v-if="r.error" class="err">{{ r.error }}</text>
            </view>
            <text v-if="r.bytes" class="size">{{ kb(r.bytes.length) }}</text>
            <!-- #ifdef APP-PLUS -->
            <view v-if="r.ok" class="act" hover-class="pressed" @click="onSaveResult(r)">导出</view>
            <!-- #endif -->
            <!-- #ifndef APP-PLUS -->
            <view v-if="r.ok" class="act" hover-class="pressed" @click="saveResult(r)">导出</view>
            <!-- #endif -->
          </view>
        </scroll-view>

        <view class="btn-row">
          <view class="btn" :class="{ off: !okCount }" hover-class="pressed" @click="okCount ? onExportAll() : null">
            [ 全部导出{{ okCount > 1 ? `（${okCount} 张）` : '' }} ]
          </view>
        </view>
      </view>

      <LogDrawer />
    </view>

    <!-- 底部常驻执行（含安全区） -->
    <view class="footer">
      <view class="exec" :class="{ busy: store.busy }" hover-class="pressed" @click="store.busy ? null : execute()">
        {{ store.busy ? (store.progress || '处理中…') : execLabel }}
      </view>
    </view>

    <!-- App：随机源桥（渲染层 webview 具备 Web Crypto，回传逻辑层池化） -->
    <!-- #ifdef APP-PLUS -->
    <view class="rng-bridge" :rngseed="rngSeed" :change:rngseed="vgrng.arm"></view>

    <!-- 密钥另存面板（主题化）：文件名由用户给定 -->
    <view v-if="keySaveOpen" class="sheet-mask" @click="keySaveOpen = false">
      <view class="sheet" @click.stop>
        <text class="sheet-title">导出密钥文件</text>
        <text class="sheet-dir">保存到：{{ settings.exportTree?.name ?? '（未选择，保存时会提示）' }}</text>
        <input v-model="keySaveName" class="sheet-input" placeholder="文件名" placeholder-class="ph" />
        <view class="sheet-item" hover-class="pressed" @click="onSaveKey">保存密钥到文件</view>
        <view class="sheet-item" hover-class="pressed" @click="copyKey(); keySaveOpen = false">复制到剪贴板</view>
        <view class="sheet-item cancel" hover-class="pressed" @click="keySaveOpen = false">取消</view>
      </view>
    </view>

    <!-- #endif -->



    <ImageZoom />

    <!-- App / 小程序：非 PNG 解码用的隐藏画布（旧版 canvas，绘图区随解码尺寸变化） -->
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
  display: flex;
  flex-direction: column;
}
.nav {
  /* 固定顶栏：不随页面滚动移动（内容据此留白，见 .content 的 padding-top） */
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  /* 顶部内边距由状态栏高度动态给出（见模板 :style） */
  padding: 16rpx 24rpx;
  border-bottom: 1rpx solid var(--line);
  background: var(--panel);
}
.brand {
  color: var(--acc);
  font-size: 30rpx;
  letter-spacing: 2rpx;
}
.meta {
  margin-left: 16rpx;
  color: var(--dim);
  font-size: 22rpx;
}
.gear {
  margin-left: auto;
  color: var(--dim);
  font-size: 34rpx;
  padding: 0 8rpx;
}
.content {
  flex: 1;
  padding: 20rpx 24rpx 0;
}
.block {
  border: 1rpx solid var(--line);
  background: var(--panel);
  padding: 20rpx 24rpx;
  margin: 20rpx 0;
}
.title {
  color: var(--acc);
  font-size: 26rpx;
  margin-bottom: 14rpx;
}
.row-between {
  display: flex;
  align-items: center;
  margin-top: 14rpx;
}
.hint {
  flex: 1;
  color: var(--dim);
  font-size: 22rpx;
}
.val {
  color: var(--acc);
  font-size: 24rpx;
}
.link {
  color: var(--acc);
  font-size: 24rpx;
  margin-left: 24rpx;
}
.link.del {
  color: var(--err);
}
.input {
  margin-top: 16rpx;
  border: 1rpx solid var(--line);
  background: var(--sunken);
  color: var(--fg);
  padding: 18rpx;
  font-size: 26rpx;
}
.ph {
  color: var(--line-hi);
}
.chips {
  margin-top: 16rpx;
}
.chip-label {
  color: var(--dim);
  font-size: 22rpx;
}
.chip-scroll {
  margin-top: 10rpx;
  white-space: nowrap;
}
.chip-row {
  display: flex;
}
.chips-inline {
  display: flex;
}
.chip {
  flex: none;
  border: 1rpx solid var(--line);
  color: var(--dim);
  font-size: 22rpx;
  padding: 6rpx 18rpx;
  margin-right: 12rpx;
}
.chip.on {
  color: var(--acc);
  border-color: var(--acc);
}
.pager {
  display: flex;
  align-items: center;
}
.pg {
  color: var(--acc);
  font-size: 30rpx;
  padding: 0 12rpx;
}
.pg.off {
  color: var(--line-hi);
}
.pg-count {
  color: var(--dim);
  font-size: 22rpx;
}
.item {
  display: flex;
  align-items: center;
  padding: 12rpx 0;
  border-bottom: 1rpx solid var(--line);
}
/* 结果滚动区：行数超限时由 resStyle 给定固定高度，超出即在区内滚动 */
.res-list {
  width: 100%;
}
.item.key {
  border-bottom: 1rpx solid var(--line-hi);
}
.mark {
  font-size: 24rpx;
  margin-right: 12rpx;
}
.mark.ok {
  color: var(--acc);
}
.mark.bad {
  color: var(--err);
}
.name {
  flex: 1;
  min-width: 0;
  color: var(--fg);
  font-size: 24rpx;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  margin-left: 14rpx;
}
.info .name {
  flex: none;
}
.err {
  color: var(--err);
  font-size: 20rpx;
  margin-top: 4rpx;
}
.thumb {
  flex: none;
  width: 76rpx;
  height: 76rpx;
  margin-left: 4rpx;
  border: 1rpx solid var(--line-hi);
  background: var(--sunken);
}
.size {
  flex: none;
  color: var(--dim);
  font-size: 22rpx;
  margin-left: 12rpx;
}
/* 行内操作按钮：与右边界保持留白，且不随长文件名压缩 */
.act {
  flex: none;
  color: var(--acc);
  font-size: 24rpx;
  border: 1rpx solid var(--line-hi);
  padding: 8rpx 22rpx;
  margin-left: 16rpx;
}
.btn-row {
  margin-top: 16rpx;
}
.btn {
  display: block;
  text-align: center;
  border: 1rpx solid var(--line-hi);
  color: var(--acc);
  padding: 20rpx 0;
  font-size: 26rpx;
}
.btn.off {
  color: var(--line-hi);
  border-color: var(--line);
}
.footer {
  position: sticky;
  bottom: 0;
  z-index: 20; /* 高于 slider 滑块等原生层，避免滑块浮在按钮之上 */
  padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom));
  background: var(--panel);
  border-top: 1rpx solid var(--line);
}
.exec {
  display: block;
  text-align: center;
  border: 1rpx solid var(--acc);
  color: var(--acc);
  padding: 26rpx 0;
  font-size: 30rpx;
}
.exec.busy {
  color: var(--warn);
  border-color: var(--warn);
}
/* 隐藏解码画布：移出可视区但保持渲染（display:none 会导致绘制失效） */
.vg-canvas {
  position: fixed;
  left: -10000px;
  top: 0;
  z-index: -1;
}
/* 随机源桥：不可见、不占空间 */
.rng-bridge {
  position: fixed;
  left: -10000px;
  top: 0;
  width: 1px;
  height: 1px;
}
/* 通用按压反馈（hover-class） */
.pressed {
  opacity: 0.55;
}
/* 密钥另存面板（主题化底部浮层） */
.sheet-mask {
  position: fixed;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 70;
  background: rgba(5, 7, 5, 0.75);
  display: flex;
  align-items: flex-end;
}
.sheet {
  width: 100%;
  background: var(--panel);
  border-top: 1rpx solid var(--line-hi);
  padding: 20rpx 24rpx calc(20rpx + env(safe-area-inset-bottom));
}
.sheet-title {
  display: block;
  color: var(--acc);
  font-size: 26rpx;
  margin-bottom: 14rpx;
}

.sheet-input {
  width: 100%;
  border: 1rpx solid var(--line);
  background: var(--sunken);
  color: var(--fg);
  padding: 16rpx;
  font-size: 26rpx;
  margin-bottom: 14rpx;
}
.sheet-item {
  display: block;
  text-align: center;
  padding: 24rpx 0;
  color: var(--acc);
  font-size: 28rpx;
  border-top: 1rpx solid var(--line);
}
.sheet-dir {
  display: block;
  color: var(--dim);
  font-size: 22rpx;
  margin-bottom: 14rpx;
}
.sheet-item.cancel {
  color: var(--dim);
}
</style>
