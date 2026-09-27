<script setup lang="ts">
import { ref } from 'vue';

const emit = defineEmits<{ (e: 'close'): void }>();

const sections = [
  { id: 'start', title: '快速上手' },
  { id: 'mode', title: '混淆方式' },
  { id: 'protect', title: '保护方式' },
  { id: 'params', title: '参数详解' },
  { id: 'security', title: '安全模型' },
  { id: 'faq', title: '注意事项' },
] as const;

const active = ref<string>('start');
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal docs">
      <div class="modal-head">
        <div class="panel-title" style="margin-bottom: 0">─ 使用文档</div>
        <button class="x-close" title="关闭" @click="emit('close')">×</button>
      </div>

      <div class="docs-body">
        <nav class="doc-nav">
          <div
            v-for="s in sections"
            :key="s.id"
            class="doc-nav-item"
            :class="{ active: active === s.id }"
            @click="active = s.id"
          >
            {{ s.title }}
          </div>
        </nav>

        <div class="doc-content">
          <div v-show="active === 'start'" class="doc-sec">
            <h3>快速上手</h3>
            <ul>
              <li><b>加密</b>：拖入目标图（可多选批量）→ 选「混淆方式」与「保护方式」→ 调参数 → <code>[ 执行加密 ]</code> → 结果区逐个下载或打包 ZIP。</li>
              <li><b>解密</b>：切到「解密」→ 拖入本工具生成的 PNG → <code>[ 执行解密 ]</code>。混淆方式与全部参数自动从图像内读取。</li>
              <li><b>预览</b>：多图时滚轮或 <code>‹ ›</code> 切换；单击图像放大，点击空白处或 Esc 返回。覆盖图层小窗（COVER）同样支持切换与放大。</li>
              <li><b>混淆图层</b>：覆盖合成模式下显示，拖入追加；左侧列表可拖动调整层序，层数上限在设置中修改。</li>
              <li><b>设置</b>：右上角齿轮 → 参数记忆、默认口令、默认覆盖图、层数上限等，均持久保存。</li>
            </ul>
          </div>

          <div v-show="active === 'mode'" class="doc-sec">
            <h3>混淆方式</h3>
            <ul>
              <li><b>密文混淆</b>：像素级密钥化可逆变换管线：通道置换 → 异或流 → [S 盒替换] → 加性噪声 → [行列移位] → 块内置换与双面体变换 → 块间置换 → [全局像素置换]。方括号项可自由叠加。全程双射，<b>逐位无损还原</b>，输出呈均匀噪声状。</li>
              <li><b>覆盖合成</b>：将一张或多张覆盖图按层叠放在目标图上形成视觉遮盖；原图经 zlib 压缩 + ChaCha20 加密后存入 PNG 私有数据块（ivGr），还原时整体取回，逐位无损。覆盖图仅作视觉遮盖，不参与还原。</li>
              <li><b>多层覆盖与目标层位</b>：覆盖图按 L1→Ln 顺序叠放；「目标图所在层」以自上而下层号选择真图插入位置——顶层表示真图压在所有覆盖图之上（可见），底层表示被完全遮盖（推荐）。</li>
              <li><b>覆盖层压缩</b>：降低覆盖层细节可显著减小输出 PNG 体积；仅影响遮盖层视觉效果，不影响原图还原精度。</li>
            </ul>
          </div>

          <div v-show="active === 'protect'" class="doc-sec">
            <h3>保护方式</h3>
            <ul>
              <li><b>无（种子内嵌）</b>：随机种子写入图像数据块，持图即可一键还原。仅用于防君子不防小人的场合。</li>
              <li><b>口令</b>：PBKDF2-SHA256（盐值随机、迭代可调）派生主密钥，头部不含密钥材料。<b>忘记口令即无法还原</b>。</li>
              <li><b>密钥文件（.ivkey）</b>：加密时生成 32 字节随机种子，在结果区手动下载为 <code>.ivkey</code> 文件（文件头 + Base64 密钥体）。解密时将其拖入凭据区即可，<b>无需关心任何参数</b>。强度高于一般人类口令；请与加密图分开保管，丢失即无法还原，泄露即等同失守。批量加密时整批共用一枚密钥文件。</li>
            </ul>
          </div>

          <div v-show="active === 'params'" class="doc-sec">
            <h3>参数详解</h3>
            <ul>
              <li><b>KDF 迭代次数</b>：PBKDF2 迭代数，决定暴力破解每次猜测的成本。20 万为平衡点；高价值场景建议 100 万以上（加密前会有可感知耗时）。仅作用于口令保护。</li>
              <li><b>分块尺寸</b>（混淆）：置换块边长。8px 细碎、32px 粗快；边缘非整块仅参与块间置换。</li>
              <li><b>噪声强度</b>（混淆）：mod 256 可逆加性噪声幅度（0–64），抹平像素直方图特征；0 关闭。</li>
              <li><b>变换轮数</b>（混淆）：完整管线重复 1–4 轮，各轮密钥流经 nonce 域分离相互独立。</li>
              <li><b>S 盒字节替换</b>（混淆）：密钥化 256 置换表对 RGB 字节做非线性替换，对抗线性/差分分析。</li>
              <li><b>行列循环移位</b>（混淆）：每行/列按密钥循环平移，打破跨块空间相关性。</li>
              <li><b>全局像素置换</b>（混淆）：整图像素级洗牌，消除一切局部统计特征；&gt;8MP 大图明显变慢。</li>
              <li><b>覆盖不透明度</b>（覆盖）：覆盖层混合比例，100% 为完全不透明。</li>
              <li><b>覆盖层压缩</b>（覆盖）：10%–100%，降低覆盖层细节以减小输出体积；不影响原图还原。</li>
              <li><b>覆盖图适配</b>（覆盖）：等比裁剪（填满并裁边）或拉伸填充（可能变形）。</li>
            </ul>
          </div>

          <div v-show="active === 'security'" class="doc-sec">
            <h3>安全模型</h3>
            <ul>
              <li>原语：ChaCha20（RFC 8439，经官方测试向量校验）密钥流、PBKDF2-SHA256、HMAC-SHA256；KDF/HMAC 使用浏览器 Web Crypto，其余为本地实现。</li>
              <li>主密钥按用途展开为 5 个独立子密钥（置换/异或/噪声/MAC/载荷），避免跨域复用；各强化算法使用独立 nonce 域。</li>
              <li>完整性：数据块经 HMAC-SHA256 校验，口令/密钥错误或文件被篡改会明确报错，绝不输出乱图。</li>
              <li>全部计算在本机浏览器内完成，图像、口令与密钥文件不经过任何网络传输。</li>
            </ul>
          </div>

          <div v-show="active === 'faq'" class="doc-sec">
            <h3>注意事项</h3>
            <ul>
              <li>输出统一为 PNG（内含 <code>ivGr</code> 私有数据块）。<b>经其他编辑器另存、压缩或转格式会丢失数据块</b>，无法还原——请妥善保管原始输出。</li>
              <li>截图、社交软件转发压缩同样会破坏数据；还原需使用原始输出文件。</li>
              <li>批量加密若使用密钥文件保护，整批共用一枚密钥文件；建议不同批次分开加密以便分级管理。</li>
              <li>「默认口令」以明文存于 localStorage；「记住参数」会保存全部参数与保护方式。公共设备离开前请清理。</li>
              <li>性能参考：1080p 基础管线约百毫秒级；全局像素置换与多轮按像素数线性增长。</li>
              <li>旧版本生成的图像与本版完全兼容（保护方式与强化参数均向后兼容读取）。</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
