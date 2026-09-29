<script setup lang="ts">
import DropZone from '@/components/DropZone.vue';
import { addCovers, run, setKeyFile } from '@/services/actions';
import { clearCovers, clearKeyFile, moveCover, removeCover, store } from '@/stores/session';
import { computed, ref } from 'vue';

const coverDrag = ref<number | null>(null);
const coverDragOver = ref<number | null>(null);

/**
 * 图层条自上而下显示，L1 即顶层——与「目标图所在层」的自上而下编号一致。
 * 每项带着存储下标 i，拖拽与删除仍按存储序（下层在前）操作，只有显示顺序是反的。
 */
const coversTopFirst = computed(() => store.covers.map((c, i) => ({ c, i })).reverse());

function onCoverDrop(i: number): void {
  if (coverDrag.value !== null && coverDrag.value !== i) moveCover(coverDrag.value, i);
  coverDrag.value = null;
  coverDragOver.value = null;
}
</script>

<template>
  <div class="panel">
    <template v-if="store.op === 'encrypt'">
      <div class="panel-title">─ 混淆方式</div>
      <div class="tabs">
        <div class="tab" :class="{ active: store.mode === 'scramble' }" @click="store.mode = 'scramble'">
          密文混淆
        </div>
        <div class="tab" :class="{ active: store.mode === 'overlay' }" @click="store.mode = 'overlay'">
          覆盖合成
        </div>
        <div class="tab" :class="{ active: store.mode === 'hybrid' }" @click="store.mode = 'hybrid'">
          密文+覆盖
        </div>
      </div>
      <div v-if="store.mode === 'hybrid'" class="hint" style="margin-bottom: 9px">
        先做密文混淆，再叠加混淆图层：看到的是图层，图层之下是密文噪声。
      </div>
      <div v-if="store.mode !== 'scramble'" style="margin-bottom: 10px">
        <div class="panel-title">─ 混淆图层</div>
        <DropZone label="混淆图像" hint="拖入 / 点击追加图层" multiple @files="addCovers" />
        <div v-if="store.covers.length" class="file-list">
          <div
            v-for="({ c, i }, d) in coversTopFirst"
            :key="c.name + i"
            class="item draggable"
            :class="{ 'drag-over': coverDragOver === i && coverDrag !== i }"
            draggable="true"
            @dragstart="coverDrag = i"
            @dragend="coverDrag = null; coverDragOver = null"
            @dragenter.prevent="coverDragOver = i"
            @dragleave="coverDragOver === i && (coverDragOver = null)"
            @dragover.prevent
            @drop.prevent="onCoverDrop(i)"
          >
            <span class="grip" title="拖动调整层序">≡</span>
            <span class="dims" title="L1 在最上层">L{{ d + 1 }}</span>
            <span class="fname" :title="c.name">{{ c.name }}</span>
            <button class="link del" title="移除" @click="removeCover(i)">×</button>
          </div>
          <div class="item foot">
            <span>共 {{ store.covers.length }} 层</span>
            <button class="link" @click="clearCovers">清空</button>
          </div>
        </div>
        <div v-if="store.covers.length" class="row" style="margin-top: 8px; margin-bottom: 0">
          <label>目标图所在层</label>
          <select v-model.number="store.targetLayer">
            <option
              v-for="p in store.covers.length + 1"
              :key="p"
              :value="store.covers.length + 1 - p"
            >
              第 {{ p }} 层{{ p === 1 ? '（顶层）' : p === store.covers.length + 1 ? '（底层）' : '' }}
            </option>
          </select>
        </div>
      </div>

      <div class="panel-title">─ 保护方式</div>
      <div class="row">
        <select v-model="store.protection">
          <option value="none">无（种子内嵌，持图即可还原）</option>
          <option value="password">口令（输入口令才能还原）</option>
          <option value="keyfile">密钥文件（.ivkey，凭文件还原）</option>
        </select>
      </div>
      <div v-if="store.protection === 'password'" class="row">
        <input v-model="store.password" type="password" placeholder="输入口令" autocomplete="off" />
      </div>
      <div v-else-if="store.protection === 'keyfile'" class="hint" style="margin-bottom: 9px">
        密钥文件在加密后于结果区手动下载。
      </div>

      <div class="panel-title">─ 参数</div>
      <div class="row">
        <label>KDF 迭代次数 <span class="val">{{ store.iterations.toLocaleString() }}</span></label>
        <input v-model.number="store.iterations" type="range" min="50000" max="3000000" step="50000" />
      </div>

      <template v-if="store.mode === 'scramble'">
        <div class="row">
          <label>可见像素布局</label>
          <select v-model="store.layout">
            <option value="payload">载荷级（原图入加密载荷，体积小）</option>
            <option value="pixel">像素级（可见像素即密文，体积大）</option>
          </select>
        </div>
        <div v-if="store.layout === 'payload'" class="hint" style="margin-bottom: 9px">
          可见像素为块状噪声装饰图，原图经滤波压缩后加密存于数据块，体积约为像素级的 1/2。
        </div>
      </template>

      <!-- 像素级密文变换：密文混淆与混合方式共用 -->
      <template v-if="store.mode !== 'overlay'">
        <div class="row">
          <label>分块尺寸</label>
          <select v-model.number="store.blockSize">
            <option :value="8">8 px（细粒度）</option>
            <option :value="16">16 px（均衡）</option>
            <option :value="32">32 px（粗粒度）</option>
          </select>
        </div>
        <div class="row">
          <label>噪声强度 <span class="val">{{ store.noise }}</span></label>
          <input v-model.number="store.noise" type="range" min="0" max="64" step="1" />
        </div>
        <div class="row">
          <label>变换轮数 <span class="val">{{ store.rounds }}</span></label>
          <input v-model.number="store.rounds" type="range" min="1" max="4" step="1" />
        </div>
        <div class="row inline">
          <input id="sbox" v-model="store.sbox" type="checkbox" />
          <label for="sbox">S 盒字节替换</label>
        </div>
        <div class="row inline">
          <input id="rowshift" v-model="store.rowshift" type="checkbox" />
          <label for="rowshift">行列循环移位</label>
        </div>
        <div class="row inline">
          <input id="gperm" v-model="store.globalPerm" type="checkbox" />
          <label for="gperm">全局像素置换（大图较慢）</label>
        </div>
      </template>

      <!-- 覆盖图层参数：覆盖合成与混合方式共用 -->
      <template v-if="store.mode !== 'scramble'">
        <div class="row">
          <label>覆盖不透明度 <span class="val">{{ Math.round(store.opacity * 100) }}%</span></label>
          <input v-model.number="store.opacity" type="range" min="0.5" max="1" step="0.05" />
        </div>
        <div class="row">
          <label>覆盖层压缩 <span class="val">{{ store.coverQuality >= 1 ? '关' : Math.round(store.coverQuality * 100) + '%' }}</span></label>
          <input v-model.number="store.coverQuality" type="range" min="0.1" max="1" step="0.05" />
        </div>
        <div class="row">
          <label>覆盖图适配</label>
          <select v-model="store.fit">
            <option value="cover">等比裁剪（cover）</option>
            <option value="stretch">拉伸填充（stretch）</option>
          </select>
        </div>
      </template>
    </template>

    <template v-else>
      <div class="panel-title">─ 凭据</div>
      <div class="row">
        <label>口令（口令保护的图像需要）</label>
        <input v-model="store.password" type="password" placeholder="无口令保护的图像留空" autocomplete="off" />
      </div>
      <div class="row">
        <label>密钥文件（密钥文件保护的图像需要）</label>
        <DropZone label=".ivkey" hint="拖入 / 点击选择" :exts="['.ivkey']" @files="setKeyFile" />
        <div v-if="store.keyFile" class="file-list">
          <div class="item">
            <span class="fname" :title="store.keyFile.name">{{ store.keyFile.name }}</span>
            <button class="link del" title="卸载" @click="clearKeyFile">×</button>
          </div>
        </div>
      </div>
      <div class="hint">混淆方式与全部参数自动从图像数据块读取。</div>
    </template>

    <div class="btn-row" style="margin-top: 12px">
      <button class="btn" :class="{ warn: store.op === 'decrypt' }" :disabled="store.busy" @click="run">
        {{ store.op === 'encrypt' ? '[ 执行加密 ]' : '[ 执行解密 ]' }}
      </button>
    </div>
  </div>
</template>
