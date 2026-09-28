<script setup lang="ts">
/**
 * 使用文档浮动面板：顶部分类横滑 + 正文滚动。
 * 以页内浮层呈现（遮罩层拦截交互，父页面在打开期间锁定滚动），
 * 由设置页打开，关闭后即回到设置。文案只用 uni 标准组件，保证小程序端可编译。
 */
import { APP_AUTHOR, APP_VERSION } from '@/app-meta';
import { topInset } from '@/services/platform/system';
import { onMounted, ref } from 'vue';

defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

/** 顶部安全距离：避免浮层顶端顶到手机状态栏 */
const padTop = ref(topInset());
onMounted(() => {
  padTop.value = topInset();
});

const sections = [
  { id: 'start', title: '快速上手' },
  { id: 'mode', title: '混淆方式' },
  { id: 'protect', title: '保护方式' },
  { id: 'params', title: '参数详解' },
  { id: 'security', title: '安全模型' },
  { id: 'strength', title: '强度评估' },
  { id: 'tips', title: '使用建议' },
  { id: 'faq', title: '注意事项' },
] as const;

const active = ref<string>('start');
</script>

<template>
  <view v-if="visible" class="mask" :style="{ paddingTop: padTop + 24 + 'px' }" @click="emit('close')">
    <view class="panel" @click.stop>
      <view class="head">
        <text class="title">─ 使用文档</text>
        <text class="x" @click="emit('close')">×</text>
      </view>

      <scroll-view class="tabs" scroll-x :show-scrollbar="false">
        <view class="tab-row">
          <text
            v-for="s in sections"
            :key="s.id"
            class="tab"
            :class="{ on: active === s.id }"
            @click="active = s.id"
          >
            {{ s.title }}
          </text>
        </view>
      </scroll-view>

      <scroll-view class="body" scroll-y :show-scrollbar="false">
        <view v-if="active === 'start'" class="sec">
          <text class="p">· <text class="em">操作模式</text>：顶部「加密 / 解密」切换，其余项与底部执行按钮随之变化。</text>
          <text class="p">· <text class="em">加密</text>：点「选图」直接进系统相册多选（H5 为文件选择框）→ 选混淆方式与保护方式 → 调参数 → 底部「执行加密」→ 结果区逐张导出或全部导出。</text>
          <text class="p">· <text class="em">解密</text>：切到「解密」→ 选入本工具生成的 PNG → 「执行解密」；混淆方式与全部参数自动读取，无需记忆。</text>
          <text class="p">· <text class="em">凭据</text>：口令保护的图像填入口令；密钥文件保护的图像点「从文件载入」（App 经系统「打开方式」选择文件）或「剪贴板」；H5 为文件选择框，小程序请先复制密钥文本再载入。</text>
          <text class="p">· <text class="em">预览</text>：左右滑动切换图像，点按进入应用内放大浮层（左右滑动切换、点空白关闭）；左上 INPUT/OUTPUT 标签切换输入与输出图集；覆盖合成时左下角 COVER 小窗预览混淆图层。</text>
          <text class="p">· <text class="em">混淆图层</text>：覆盖合成时出现，点「加图层」追加；缩略图下方 ↑↓ 调整层序，层数上限在设置中修改。</text>
          <text class="p">· <text class="em">结果区</text>：每次执行产生一批结果（含该批密钥），可翻阅历史批次、删除本批、查看缩略图与大小；点按结果缩略图可放大查看。结果仅存于本次运行，退出即清空。</text>
          <text class="p">· <text class="em">导出</text>：H5 为浏览器下载；App 写入设置中选定的文件夹（见下），未选择时首次导出会引导选择；小程序保存到相册。若浏览器拦截自动下载，会改为新标签打开，右键另存即可。</text>
          <text class="p">· <text class="em">存储位置</text>（App）：设置页点「选择文件夹」，经系统「打开方式」自选任意目录（下载 / 文档 / 自建文件夹 / 外置卡均可），授权长期有效；导出与密钥均写入该目录，同名文件直接覆盖。</text>
          <text class="p">· <text class="em">设置</text>：右上角 ⚙ 进入设置页 → 存储位置（App）、参数记忆、默认口令、默认混淆图与大小上限、图层上限；本页入口亦在其中，返回即回到设置。</text>
        </view>

        <view v-if="active === 'mode'" class="sec">
          <text class="p">· <text class="em">密文混淆</text>：像素级密钥化可逆变换管线：通道置换 → 异或流 → [S 盒替换] → 加性噪声 → [行列移位] → 块内置换与双面体变换 → 块间置换 → [全局像素置换]。方括号项可自由叠加。全程双射，逐位无损还原，输出呈均匀噪声状；每次加密生成独立随机 IV，同一密钥下各图绝不共享密钥流。</text>
          <text class="p">· <text class="em">覆盖合成</text>：将一张或多张混淆图叠放在目标图上形成视觉遮盖；原图经 zlib 压缩 + ChaCha20 加密后存入 PNG 私有数据块，还原时整体取回，逐位无损。混淆图仅作遮盖，不参与还原。</text>
          <text class="p">· <text class="em">多层与目标层位</text>：混淆图按 L1→Ln 叠放；「目标图所在层」以自上而下层号选择真图插入位置——顶层表示真图压在所有混淆图之上（可见），底层表示被完全遮盖（推荐）。</text>
          <text class="p">· <text class="em">覆盖层压缩</text>：降低遮盖层细节以减小输出体积，不影响原图还原精度。</text>
          <text class="p">· <text class="em">多图合并</text>：开启「多图合并为一张」后，本批全部目标图合并输出为一张图；原图全部装入加密载荷，解密时自动展开为全部原图。合并标志随元数据加密，凭同一凭据自动识别。</text>
        </view>

        <view v-if="active === 'protect'" class="sec">
          <text class="p">· <text class="em">无（种子内嵌）</text>：随机种子写入图像数据块，持图即可还原，属混淆而非加密，仅用于防君子场景。</text>
          <text class="p">· <text class="em">口令</text>：PBKDF2-SHA256（盐值随机、迭代可调）派生主密钥，文件中不含任何密钥材料；忘记口令即无法还原。</text>
          <text class="p">· <text class="em">密钥文件（.ivkey）</text>：加密时生成 32 字节随机种子，在结果区导出（多行文本：格式头 + 创建时间 + 密钥指纹 + Base64 种子）。解密时载入同一密钥即可，无需关心任何参数。强度高于一般人类口令；请与图像分开保管。</text>
          <text class="p">· <text class="em">移动端提示</text>：H5 直接下载 .ivkey；App 在结果区可把密钥写入所选文件夹（文件名可自定，与图像分开存放）；小程序无自由文件写入能力，导出为「复制到剪贴板」——请及时转存到安全位置。</text>
        </view>

        <view v-if="active === 'params'" class="sec">
          <text class="p">· <text class="em">KDF 迭代次数</text>：PBKDF2 迭代数，决定暴力破解成本。20 万为平衡点；高价值数据建议 100 万以上（加密前会有可感知耗时）。仅作用于口令保护。移动端若运行环境缺少 Web Crypto，将走纯 TS 派生路径，同等迭代下更慢。</text>
          <text class="p">· <text class="em">分块尺寸</text>（混淆）：置换块边长，8px 细碎、32px 粗快；边缘非整块仅参与块间置换。</text>
          <text class="p">· <text class="em">噪声强度</text>（混淆）：mod 256 可逆加性噪声幅度，抹平直方图特征。</text>
          <text class="p">· <text class="em">变换轮数</text>（混淆）：完整管线重复 1–4 轮，各轮密钥流经 nonce 域分离相互独立。</text>
          <text class="p">· <text class="em">S 盒替换 / 行列移位 / 全局像素置换</text>（混淆）：非线性替换、行列循环平移、整图洗牌，逐级强化；全局置换在大图上明显变慢。</text>
          <text class="p">· <text class="em">覆盖不透明度 / 覆盖层压缩 / 混淆图适配</text>（覆盖）：混合比例、遮盖层细节保留度、等比裁剪或拉伸。</text>
          <text class="p">· <text class="em">参数存放</text>：非默认选项随元数据一并加密存入图像，解密端自动读取。</text>
        </view>

        <view v-if="active === 'security'" class="sec">
          <text class="p">· 原语：ChaCha20（RFC 8439，经官方测试向量校验）密钥流、PBKDF2-SHA256、HMAC-SHA256；移动端在无 Web Crypto 时使用内置纯 TS 实现，两条路径输出逐位一致。</text>
          <text class="p">· 主密钥按用途展开为 6 个独立子密钥（置换 / 异或流 / 噪声 / MAC / 载荷 / 元数据），避免跨域复用。</text>
          <text class="p">· 逐图随机 IV：每次加密随机 salt 决定唯一密钥流，批量加密也不复用。</text>
          <text class="p">· 元数据加密：公开字段仅保留引导派生所需的版本、盐值、迭代数与随机种子；模式、保护方式、参数、原图尺寸全部加密，文件不含工具品牌标识。</text>
          <text class="p">· 保护方式不可区分：三种方式统一为「字节凭据 → PBKDF2 → 主密钥」，公开种子恒为等长随机。</text>
          <text class="p">· 完整性：HMAC 覆盖公开前导、加密元数据与密文像素，任何改动都会在解密时被拒绝。</text>
          <text class="p">· 无损解码：解密内置 PNG 解码器逐位还原，不经平台画布的色彩管理与预乘处理。</text>
          <text class="p">· 全部计算在本机完成，图像、口令与密钥不经过任何网络传输。</text>
        </view>

        <view v-if="active === 'strength'" class="sec">
          <text class="p">· <text class="em">无保护</text>：混淆（非加密），持图即可还原，仅降低随手查看的可见度。</text>
          <text class="p">· <text class="em">口令</text>：高。未知口令无法还原；实际强度取决于口令熵与迭代成本。</text>
          <text class="p">· <text class="em">密钥文件</text>：高—极高。256 位全熵密钥，文件不泄露时搜索空间与强加密等价。</text>
          <text class="p">· <text class="em">为何抗拼图攻击</text>：像素在置换前先与密钥流逐字节异或，值被均匀化，边缘连续性、直方图、分块相关性等先验全部失效。</text>
          <text class="p">· <text class="em">密钥流不跨图复用</text>：逐图随机 IV，杜绝两图相异或消密钥类攻击。</text>
          <text class="p">· <text class="em">局限</text>：弱口令仍可离线爆破；文件带有私有数据块，专业分析可判断「经过本工具处理」，但不泄露内容与参数；凭据保管与传输安全超出工具能力。</text>
        </view>

        <view v-if="active === 'tips'" class="sec">
          <text class="p">· 口令优先 12 位以上随机串或长短语；迭代 20 万起，高价值数据 100 万以上。</text>
          <text class="p">· 密钥文件与加密图分开存放（不同设备/云盘）；批量加密同一批共用一枚便于分级管理。</text>
          <text class="p">· 传输务必使用原始 PNG 文件，避免截图、社交软件压图、在线转码。</text>
          <text class="p">· 加密前保留原图，加密后保留输出与凭据，三者缺一不可。</text>
          <text class="p">· 场景选择：只要「看不出内容、自己可还原」→ 覆盖合成；想要强噪声输出 → 密文混淆；仅降低随手查看的可见度 → 无保护即可，切勿用于敏感数据。</text>
          <text class="p">· 移动端性能：大图（尤其开启全局像素置换或多轮）耗时明显；建议先在小图上确认参数再处理大图。</text>
        </view>

        <view v-if="active === 'faq'" class="sec">
          <text class="p">· 输出统一为 PNG（内含私有数据块），经其他编辑器另存、压缩或转格式会丢失数据块，无法还原。</text>
          <text class="p">· 截图与社交软件转发压缩同样会破坏数据；还原必须使用原始输出文件。</text>
          <text class="p">· App 直接把输出写入所选文件夹（字节精确，同名覆盖）；小程序保存到相册经系统相册流程，通常不改变像素；若平台做了额外压缩，请改用 H5 端下载原始文件。</text>
          <text class="p">· 小程序端图像边长上限 4096px，超出请先在系统相册裁剪或改用 App/H5。</text>
          <text class="p">· 「默认口令」以明文存于本机存储；「记住参数」会保存全部参数与保护方式，公共设备离开前请清理。</text>
          <text class="p">· 保护方式会记住上次选择，首次使用默认口令；默认口令填入后，切到口令且输入框为空时自动补全。</text>
        </view>

        <view class="tail">
          <text class="dim">v{{ APP_VERSION }} · by {{ APP_AUTHOR }}</text>
        </view>
      </scroll-view>
    </view>
  </view>
</template>

<style scoped>
/*
 * 浮动面板：遮罩铺满视口并拦截交互（父页面在打开期间另锁滚动），
 * 面板高度取满遮罩内容区，顶栏与分类条固定，正文在滚动区内。
 */
.mask {
  position: fixed;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 100;
  background: rgba(5, 7, 5, 0.88);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 60rpx 40rpx;
}
.panel {
  width: 100%;
  max-width: 720rpx;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1rpx solid var(--line-hi);
  background: var(--panel);
}
.head {
  flex: none;
  display: flex;
  align-items: center;
  padding: 22rpx 24rpx;
  border-bottom: 1rpx solid var(--line);
}
.title {
  color: var(--acc);
  font-size: 26rpx;
}
.x {
  margin-left: auto;
  color: var(--dim);
  font-size: 34rpx;
  line-height: 1;
  padding: 0 8rpx;
}
.tabs {
  flex: none;
  white-space: nowrap;
  border-bottom: 1rpx solid var(--line);
  background: var(--panel);
}
.tab-row {
  display: flex;
  padding: 12rpx 16rpx;
}
/* flex: none 保证标签不压缩，横向滚动才成立 */
.tab {
  flex: none;
  border: 1rpx solid var(--line);
  color: var(--dim);
  font-size: 24rpx;
  padding: 8rpx 22rpx;
  margin-right: 12rpx;
}
.tab.on {
  color: var(--acc);
  border-color: var(--acc);
}
/*
 * 滚动区：flex: 1 + min-height: 0 才能收缩并内部滚动
 * （默认 min-height: auto 会让内容撑破面板且不出现滚动条）。
 * 内边距交给内容块，避免小程序端滚动内容被裁剪。
 */
.body {
  flex: 1;
  min-height: 0;
}
.sec {
  padding: 20rpx 24rpx;
}
.p {
  display: block;
  color: var(--fg);
  font-size: 25rpx;
  line-height: 1.75;
  margin-bottom: 12rpx;
}
.em {
  color: var(--acc);
  font-weight: bold;
}
.tail {
  padding: 20rpx 24rpx;
  text-align: center;
}
.dim {
  color: var(--dim);
  font-size: 22rpx;
}
</style>
