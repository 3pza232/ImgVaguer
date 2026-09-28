<script setup lang="ts">
import { clearDefaultCover, setDefaultCover } from '@/services/actions';
import {
  clampCovers,
  clampTargets,
  COVER_MAX,
  COVER_MIN,
  saveSettings,
  settings,
  TARGET_MAX,
  TARGET_MIN,
} from '@/stores/session';
import { ref } from 'vue';

const emit = defineEmits<{ (e: 'close'): void; (e: 'docs'): void }>();

const coverInput = ref<HTMLInputElement>();

/** 像素上限档位：合并体积随张数线性增长，故给足跨度而不放任无界 */
const pixelChoices = [20_000_000, 40_000_000, 60_000_000];

function onCoverPick(e: Event): void {
  const el = e.target as HTMLInputElement;
  const f = el.files?.[0];
  el.value = '';
  if (f) void setDefaultCover(f);
}

function onPasswordSave(): void {
  saveSettings();
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function adjustMaxMB(d: number): void {
  settings.defaultCoverMaxMB = clamp(Math.round((settings.defaultCoverMaxMB + d) * 10) / 10, 0.5, 50);
  saveSettings();
}

function adjustMaxLayers(d: number): void {
  settings.maxCoverLayers = clampCovers(settings.maxCoverLayers + d);
  saveSettings();
}

/** 手动输入后收敛到区间，避免越界值留在设置里 */
function commitMaxLayers(): void {
  settings.maxCoverLayers = clampCovers(settings.maxCoverLayers);
  saveSettings();
}

function adjustMaxTargets(d: number): void {
  settings.maxTargets = clampTargets(settings.maxTargets + d);
  saveSettings();
}

/** 手动输入后收敛到区间，避免越界值留在设置里 */
function commitMaxTargets(): void {
  settings.maxTargets = clampTargets(settings.maxTargets);
  saveSettings();
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <div class="panel-title" style="margin-bottom: 0">─ 设置</div>
        <button class="x-close" title="关闭" @click="emit('close')">×</button>
      </div>

      <div class="set-sec">
        <div class="set-label">记忆</div>
        <div class="row inline" style="margin-bottom: 0">
          <input id="remember" v-model="settings.rememberParams" type="checkbox" @change="saveSettings" />
          <label for="remember">记住参数调节（保存于浏览器本地）</label>
        </div>
      </div>

      <div class="set-sec">
        <div class="set-label">默认口令</div>
        <input
          v-model="settings.defaultPassword"
          type="password"
          placeholder="留空则不设置；口令模式下输入框为空时自动填入"
          autocomplete="off"
          @change="onPasswordSave"
        />
        <div class="hint warn-text">⚠ 明文存于 localStorage，公共设备勿用。</div>
      </div>

      <div class="set-sec">
        <div class="set-label">默认混淆图（下次启动时载入）</div>
        <div class="row inline">
          <button class="btn mini" @click="coverInput?.click()">[ 选择图像 ]</button>
          <span class="set-value" :title="settings.defaultCover?.name">
            {{ settings.defaultCover?.name ?? '未设置' }}
          </span>
          <button v-if="settings.defaultCover" class="link del" title="清除" @click="clearDefaultCover">×</button>
        </div>
        <div class="row inline" style="margin-bottom: 0">
          <label for="covermax">大小上限</label>
          <span class="num-wrap">
            <button class="num-btn" title="减少" @click="adjustMaxMB(-0.5)">−</button>
            <input
              id="covermax"
              v-model.number="settings.defaultCoverMaxMB"
              type="number"
              min="0.5"
              max="50"
              step="0.5"
              @change="saveSettings"
            />
            <button class="num-btn" title="增加" @click="adjustMaxMB(0.5)">+</button>
          </span>
          <span class="hint" style="margin-top: 0">MB</span>
        </div>
        <input ref="coverInput" type="file" accept="image/*" hidden @change="onCoverPick" />
      </div>

      <div class="set-sec">
        <div class="set-label">覆盖图层上限</div>
        <div class="row inline" style="margin-bottom: 0">
          <span class="num-wrap">
            <button class="num-btn" title="减少" @click="adjustMaxLayers(-1)">−</button>
            <input
              v-model.number="settings.maxCoverLayers"
              type="number"
              :min="COVER_MIN"
              :max="COVER_MAX"
              step="1"
              @change="commitMaxLayers"
            />
            <button class="num-btn" title="增加" @click="adjustMaxLayers(1)">+</button>
          </span>
          <span class="hint" style="margin-top: 0">层（{{ COVER_MIN }}–{{ COVER_MAX }}）</span>
        </div>
      </div>

      <div class="set-sec">
        <div class="set-label">批量上限</div>
        <div class="row inline">
          <label for="maxtargets">目标图数量</label>
          <span class="num-wrap">
            <button class="num-btn" title="减少" @click="adjustMaxTargets(-1)">−</button>
            <input
              id="maxtargets"
              v-model.number="settings.maxTargets"
              type="number"
              :min="TARGET_MIN"
              :max="TARGET_MAX"
              step="1"
              @change="commitMaxTargets"
            />
            <button class="num-btn" title="增加" @click="adjustMaxTargets(1)">+</button>
          </span>
          <span class="hint" style="margin-top: 0">张（{{ TARGET_MIN }}–{{ TARGET_MAX }}）</span>
        </div>
        <div class="row inline" style="margin-bottom: 0">
          <label>单张像素上限</label>
          <select v-model.number="settings.maxPixels" @change="saveSettings">
            <option v-for="p in pixelChoices" :key="p" :value="p">{{ p / 10000 }} 万</option>
          </select>
        </div>
        <div class="hint">合并张数越多，输出体积越接近各原文件之和；像素上限用于挡掉解码即耗尽内存的巨图。</div>
      </div>

      <div class="set-sec">
        <div class="set-label">帮助</div>
        <button class="btn mini" @click="emit('docs')">[ 打开使用文档 ]</button>
      </div>

      <div class="btn-row" style="margin-top: 14px">
        <button class="btn" @click="emit('close')">[ 关闭 ]</button>
      </div>
    </div>
  </div>
</template>
