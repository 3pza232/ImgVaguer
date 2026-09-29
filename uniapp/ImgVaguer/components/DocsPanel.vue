<script setup lang="ts">
/**
 * 使用文档浮动面板：顶部分类横滑 + 正文滚动。
 * 以页内浮层呈现（遮罩层拦截交互，父页面在打开期间锁定滚动），
 * 由设置页打开，关闭后即回到设置。文案只用 uni 标准组件，保证小程序端可编译。
 */
import { APP_AUTHOR, APP_VERSION } from '@/app-meta';
import { topInset } from '@/services/platform/system';
import { COVER_MAX, COVER_MIN, TARGET_MAX, TARGET_MIN } from '@/stores/session';
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
  { id: 'terms', title: '名词解释' },
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
          <text class="p">· <text class="em">这个工具在做什么</text>：把一张普通图片变成「看起来是另一张图」的样子，同时把原图完整地藏在文件内部——只有拿着口令或密钥文件的人才能原样取回来。全部过程都在手机上完成，图片与口令不会上传到任何地方。</text>
          <text class="p">· <text class="em">加密</text>：点「选图」进系统相册多选（H5 为文件选择框）→ 选「混淆方式」（输出长什么样）与「保护方式」（靠什么钥匙还原），需要时调参数 → 底部「执行加密」→ 结果区逐张导出或全部导出。</text>
          <text class="p">· <text class="em">解密</text>：切到「解密」→ 选入本工具生成的 PNG → 「执行解密」。混淆方式、保护方式与全部参数都写在文件里，程序自己读，不需要你记着当初怎么设的。</text>
          <text class="p">· <text class="em">凭据</text>：口令保护的图像填入口令；密钥文件保护的图像点「从文件载入」（App 经系统「打开方式」选择文件）或「剪贴板」；H5 为文件选择框，小程序请先复制密钥文本再载入。</text>
          <text class="p">· <text class="em">预览</text>：左右滑动切换图像，点按进入应用内放大浮层（左右滑动切换、点空白关闭）；左上 INPUT/OUTPUT 标签切换输入与输出图集；覆盖合成与混合方式下左下角 COVER 小窗预览混淆图层。</text>
          <text class="p">· <text class="em">混淆图层</text>：覆盖合成或混文+覆盖时出现，点「加图层」追加；缩略图下方 ↑↓ 调整层序，层数上限在设置中修改。</text>
          <text class="p">· <text class="em">结果区</text>：每次执行产生一批结果（含该批密钥），可翻阅历史批次、删除本批、查看缩略图与大小；点按结果缩略图可放大查看。<text class="em">[ 性能分析 ]</text> 会打开本批的耗时与体积明细（见「使用建议」）。结果仅存于本次运行，退出即清空，请及时导出。</text>
          <text class="p">· <text class="em">导出</text>：H5 为浏览器下载；App 写入设置中选定的文件夹（见下），未选择时首次导出会引导选择；小程序保存到相册。若浏览器拦截自动下载，会改为新标签打开，长按或右键另存即可。</text>
          <text class="p">· <text class="em">存储位置</text>（App）：设置页点「选择文件夹」，经系统「打开方式」自选任意目录（下载 / 文档 / 自建文件夹 / 外置卡均可），授权长期有效；导出与密钥文件都写入该目录，同名文件直接覆盖。</text>
          <text class="p">· <text class="em">设置</text>：右上角 ⚙ 进入设置页 → 存储位置（App）、参数记忆、默认口令、默认混淆图与大小上限、图层与张数上限；本页入口亦在其中，返回即回到设置。</text>
        </view>

        <view v-if="active === 'terms'" class="sec">
          <text class="p">· <text class="em">混淆 vs 加密</text>：<text class="em">加密</text>是靠钥匙才能读；<text class="em">混淆</text>只是让人一眼看不出内容，没有钥匙也能还原。「无保护」档属于后者，其余档位都带真正的加密。</text>
          <text class="p">· <text class="em">载荷</text>：藏在文件内部的那份真正内容。可以把它想成<text class="em">行李箱里的东西</text>——外面看的是一张图，箱子里的原图才是要保护的对象。</text>
          <text class="p">· <text class="em">可见像素</text>：别人打开文件时看到的那张图，相当于<text class="em">行李箱的外壳</text>。它可以是噪声、遮盖图，甚至与原图毫无关系；只要载荷在，还原就不受影响。</text>
          <text class="p">· <text class="em">还原 / 逐位无损</text>：还原指把载荷取出、拼回原始文件。逐位无损意味着取出后的文件与原文件一个字节都不差（不是「看起来差不多」），文件名与格式也保持不变。</text>
          <text class="p">· <text class="em">重编码</text>：用图片编辑器、截图或社交软件转发时，图片会被重新压缩、重新存一遍，这一步会破坏文件内部结构。本工具的输出<text class="em">不能</text>经过重编码，必须原样发送。</text>
          <text class="p">· <text class="em">口令 / 密钥文件 / 种子</text>：口令是你想得起来的一串字；密钥文件是程序生成的 32 字节随机数（写成一个 .ivkey 文本文件），猜不出来；种子就是这个随机数本身。</text>
          <text class="p">· <text class="em">密钥派生、迭代次数、盐</text>：密钥派生是把口令「揉」成一把真正可用钥匙的过程——口令本身不能直接当钥匙用。迭代次数就是「揉」多少遍：揉得越多，别人逐个试口令就越慢。盐是一段随机值，保证即便两个人用同一个口令，也不会得到同一把钥匙。</text>
          <text class="p">· <text class="em">HMAC（完整性校验）</text>：相当于贴在文件上的<text class="em">防拆封条</text>。文件（包括像素）被任何人改动过，解密时都会被发现并明确报错，而不会给你一张错图。</text>
          <text class="p">· <text class="em">像素 / 通道 / 不透明度</text>：一张图由许多小方块（像素）拼成，每个像素由红、绿、蓝、透明四个数值描述（即四个通道）。不透明度就是两个图层叠在一起时，上层盖住下层的比例。</text>
          <text class="p">· <text class="em">元数据（EXIF）</text>：照片里除画面之外附带的信息，比如拍摄时间、机型、GPS 位置。它跟着文件走，别人拿到图就能读到。</text>
          <text class="p">· <text class="em">图层与层序</text>：多个混淆图叠在一起时，每一张称为一个图层；谁盖住谁是层序。本工具中图层条自上而下显示，<text class="em">L1 在最上层</text>。</text>
          <text class="p">· <text class="em">PNG 数据块</text>：PNG 文件由若干「数据块」拼成，其中有些块留给程序自定义。本工具把加密后的内容放在这样一个自定义块里，其他看图软件会忽略它、只显示可见像素。</text>
          <text class="p">· <text class="em">四段耗时</text>：结果区的「性能分析」把一批任务的时间拆成四段——密钥派生（由口令或密钥文件推出密钥）、载荷处理（打包压缩与加解密）、像素处理（位图解码与混淆 / 合成）、输出封装（PNG 编码、预览与落地）；此外还有一段「图层与批级开销」（不使用图层的方式显示为「批级开销」），等于批次总耗时减去各张耗时之和——它包含整批共用的图层解码与界面刷新等，但不含你手动点击的导出 / 打包，那是执行结束后另外发生的动作。</text>
        </view>

        <view v-if="active === 'mode'" class="sec">
          <text class="p">· <text class="em">密文混淆</text>：输出是一张<text class="em">噪声图</text>——看得出「被处理过」，但看不出是什么。原图完整地存进文件内部。「载荷级」（推荐）以原始文件字节加密存放，解密后得到的文件与原文件完全一致（格式、清晰度、体积都一样），可见的那张噪声图尺寸是独立的，连原图多大都不会泄露，速度最快、体积也与原文件相当；「像素级」不做行李箱，直接把画面逐像素打乱（通道置换 → 异或流 → [S 盒替换] → 加性噪声 → [行列移位] → 块内与块间置换 → [全局像素置换]，方括号项可自由叠加），解密由像素反推回图片，代价是体积约 4 字节/像素，明显更大也更慢。两者都逐位无损，且每次加密都重新生成随机值，同一口令加密多张图也绝不共用同一段密钥流。</text>
          <text class="p">· <text class="em">覆盖合成</text>：用一张或多张混淆图把目标图盖住，输出就是那张正常图片；原图同样完整存进文件内部。混淆图只负责「看上去像什么」，不参与还原。</text>
          <text class="p">· <text class="em">密文 + 覆盖（混合）</text>：先做像素级密文混淆，再把混淆图层盖上去。第一眼看到的是图层；但如果有人把图层褪掉、或把不透明度调成半透明（例如在图片软件里反解混合），露出来的是<text class="em">密文噪声而不是原图</text>。适合「既要看起来正常、又不想在像素层留下原图痕迹」的场合，耗时约等于前两者相加，原图仍逐位无损还原。</text>
          <text class="p">· <text class="em">为什么混合方式没有「可见像素布局」可选</text>：像素级布局的含义是「密文直接驻留在可见像素里、不另存载荷」，而混合方式的图层会盖住像素，像素里的密文随之被破坏。因此混合方式的原图只能走加密载荷，可见像素布局固定为<text class="em">载荷级</text>——这与纯密文混淆不同，不是功能缺失。</text>
          <text class="p">· <text class="em">三者的取舍</text>：想让人一眼看出是密文 → 密文混淆；想让输出像一张正常照片 → 覆盖合成；想两者都要 → 混合方式（耗时约等于前两者相加）。</text>
          <text class="p">· <text class="em">多层与目标层位</text>：图层条<text class="em">自上而下显示，L1 在最上层</text>；↑↓ 可调整层序。「目标图所在层」按自上而下的层号选择真图插在哪里——选「第 1 层（顶层）」真图会压在全部图层之上（肉眼可见），选「底层」（默认）则被完全盖住。</text>
          <text class="p">· <text class="em">覆盖层压缩</text>：降低遮盖层细节以减小输出体积，只影响外观，与原图还原精度无关。</text>
          <text class="p">· <text class="em">多图合并</text>：开启「多图合并为一张」后，本批全部目标图合并输出为一张图；全部原文件装入加密载荷，解密时逐一还原（混淆图不参与）。合并标志随元数据加密，凭同一凭据自动识别，三种保护方式都支持。</text>
        </view>

        <view v-if="active === 'protect'" class="sec">
          <text class="p">· <text class="em">无（种子内嵌）</text>：钥匙就写在文件里，任何人拿到图都能还原。它属于<text class="em">混淆</text>，只有「防随手一看」的价值，<text class="em">请勿用于敏感内容</text>。</text>
          <text class="p">· <text class="em">口令</text>：用你输入的口令派生出钥匙（PBKDF2-SHA256，盐值随机、迭代可调），文件中<text class="em">不含任何钥匙材料</text>。不知道口令就还原不了——忘记口令同样无法找回，本工具不提供任何后门或找回途径。</text>
          <text class="p">· <text class="em">密钥文件（.ivkey）</text>：加密时生成 32 字节随机种子，在结果区导出（多行文本：格式头 + 创建时间 + 密钥指纹 + Base64 种子）。解密时载入同一密钥即可，<text class="em">无需关心任何参数</text>。强度高于一般人类口令。<text class="em">丢失即无法还原，泄露即等同失守</text>；批量加密时整批共用一枚。</text>
          <text class="p">· <text class="em">怎么选</text>：随手保护用「口令」；重要资料或想要机器级强度用「密钥文件」；「无」只用于不敏感内容。口令的强度取决于它有多难猜，密钥文件的强度取决于那 32 个随机字节，与好不好记无关。</text>
          <text class="p">· <text class="em">移动端提示</text>：H5 直接下载 .ivkey；App 在结果区可把密钥写入所选文件夹（文件名可自定，务必与图像分开存放）；小程序无自由文件写入能力，导出为「复制到剪贴板」——请及时转存到安全位置。</text>
        </view>

        <view v-if="active === 'params'" class="sec">
          <text class="p">· <text class="em">KDF 迭代次数</text>（仅口令）：把口令「揉」成钥匙要揉多少遍。揉得多，暴力试口令的成本就高，代价是加密时多等一会儿。20 万为平衡点；高价值内容可用 100 万以上（会有可感知的等待）。密钥文件与「无保护」用的是全随机种子，不需要揉，所以几乎瞬时。</text>
          <text class="p">· <text class="em">可见像素布局</text>（密文混淆）：决定「外壳」怎么做，不影响内容与强度。载荷级外壳是装饰噪声、体积小、速度快；像素级外壳本身就是密文，体积约 4 字节/像素。拿不准就用载荷级。</text>
          <text class="p">· <text class="em">分块尺寸</text>（像素级 / 混合）：打乱的最小单位，8px 打得更碎、32px 更快；边缘不足一块的部分只参与块间打乱。</text>
          <text class="p">· <text class="em">噪声强度</text>（像素级 / 混合）：给像素值加上可逆的随机扰动（0–64），把「哪些颜色多、哪些颜色少」这类统计特征抹平；0 表示关闭。</text>
          <text class="p">· <text class="em">变换轮数</text>（像素级 / 混合）：整套打乱重复 1–4 遍，每一遍用的是不同密钥流，因此多轮确实更难还原，代价是更慢。</text>
          <text class="p">· <text class="em">S 盒替换 / 行列移位 / 全局像素置换</text>（像素级 / 混合）：非线性替换（输入变一点、输出变很多）、整行整列错位、全图密钥化洗牌，逐级强化；全局置换在大图上明显变慢。</text>
          <text class="p">· <text class="em">覆盖不透明度 / 覆盖层压缩 / 混淆图适配</text>（覆盖 / 混合）：图层盖住目标图的力度（100% 为完全盖住）、遮盖层细节保留度、等比裁剪或拉伸填充。</text>
          <text class="p">· <text class="em">参数存放</text>：混淆方式、保护方式与上述全部参数都随元数据加密写进图片，解密端自动读取——所以解密时只需要凭据，不需要回忆参数。</text>
        </view>

        <view v-if="active === 'security'" class="sec">
          <text class="p">· <text class="em">用什么算法</text>：ChaCha20（RFC 8439，经官方测试向量校验）做密钥流加密，PBKDF2-SHA256 派生口令密钥，HKDF-SHA256 处理全随机种子，HMAC-SHA256 做完整性校验；均为公开、经过长期检验的标准算法。移动端在没有 Web Crypto 的运行时使用内置纯 TS 实现，两条路径输出逐位一致。</text>
          <text class="p">· <text class="em">一把钥匙分六份用</text>：主密钥按用途展开为 6 个互不相干的子密钥（置换 / 异或流 / 噪声 / MAC / 载荷 / 元数据），每个子步骤、每一轮、每种载荷各有独立随机域，同一把钥匙的不同用途之间不会互相削弱。</text>
          <text class="p">· <text class="em">每张图都换新密钥流</text>：每次加密都会生成随机 salt，据此决定该图的密钥流起点，因此同一口令加密一批图，彼此之间也不存在「两图相减抵消钥匙」的可能。</text>
          <text class="p">· <text class="em">公开字段只剩必要信息</text>：文件里能被直接读到的只有格式版本、盐值、迭代次数与一段随机种子（三种保护方式的种子长度相同，单看文件无法分辨用的是哪种）。混淆方式、原图尺寸、全部参数与内容本身都是加密存放的，文件里也没有工具品牌标识。</text>
          <text class="p">· <text class="em">凭据派生</text>：口令走 PBKDF2 迭代拉伸以抬高试错成本；密钥文件种子与内嵌种子是 256 位全随机，走 HKDF-SHA256。</text>
          <text class="p">· <text class="em">改一个像素都能发现</text>：HMAC 覆盖公开前导、加密元数据与真正承载密文的那一部分，口令或密钥不对、文件被篡改都会在解密时明确报错，而不会输出一张错图。</text>
          <text class="p">· <text class="em">还原不经过滤镜</text>：载荷级直接返回原始文件字节，逐字节一致；像素级走内置 PNG 解码器逐位还原，不经过平台画布的色彩管理与预乘处理（等价于原图的 RGB 编码会在解码时补回 alpha=255）。</text>
          <text class="p">· <text class="em">能防什么、不能防什么</text>：目标是「内容不可读 + 可校验还原 + 全程离线」。它能防住拿到文件的人；防不住弱口令被离线暴破，也不承诺不可否认性或隐写级的「看不出被处理过」。</text>
          <text class="p">· 全部计算在本机完成，图像、口令与密钥不经过任何网络传输。</text>
        </view>

        <view v-if="active === 'strength'" class="sec">
          <text class="p">· <text class="em">无保护</text>：混淆（非加密），持图即可还原，仅降低随手查看的可见度。</text>
          <text class="p">· <text class="em">口令</text>：高。不知道口令无法还原；实际强度取决于口令有多难猜、以及迭代次数带来的试错成本。</text>
          <text class="p">· <text class="em">密钥文件</text>：高—极高。256 位纯随机钥匙，文件不泄露时搜索空间与强加密等价。</text>
          <text class="p">· <text class="em">为何拼图式攻击不成立</text>：像素级布局在打乱之前先让每个字节与密钥流做异或，像素值被均匀化，边缘的连续性、颜色分布、分块之间的相关性这些「可借用的线索」都不再成立；载荷级布局更进一步，可见像素根本不参与还原。</text>
          <text class="p">· <text class="em">密钥流不跨图复用</text>：每张图随机生成起点，杜绝两图相减把钥匙消掉这类做法。</text>
          <text class="p">· <text class="em">强度的真正短板</text>：弱口令仍可能被逐个试出来；文件结构上仍能看出「经过本工具处理」（但看不出内容与参数）；口令与密钥文件怎么保管、怎么传递，超出工具本身能保护的范围。</text>
        </view>

        <view v-if="active === 'tips'" class="sec">
          <text class="p">· 口令优先用 12 位以上随机串或一句长短语（越不像话越好）；迭代 20 万起，重要内容用 100 万以上。</text>
          <text class="p">· 密钥文件与加密图分开存放（不同设备 / 云盘）；泄露即等同失守。同一批数据用同一枚便于分级管理。</text>
          <text class="p">· 传输务必使用原始 PNG 文件，避免截图、社交软件压图、在线转码。</text>
          <text class="p">· 加密前保留原图，加密后保留输出与凭据，三者缺一不可。</text>
          <text class="p">· 按场景选：只要「看不出内容、自己可还原」→ 覆盖合成；想要可辨认的密文噪声图 → 密文混淆（默认载荷级）；既像正常照片、又不想在像素层留痕 → 密文 + 覆盖；仅降低随手查看的可见度 → 无保护即可，切勿用于敏感数据。</text>
          <text class="p">· 体积：载荷级密文混淆、覆盖合成与多图合并的输出就是「原文件 + 一张小尺寸装饰图 / 遮盖图」，通常只比原文件大百分之几；像素级与混合方式的可见像素不可压缩，体积明显更大（约 4 字节/像素）。</text>
          <text class="p">· 移动端性能：载荷级与覆盖合成只需读取原文件字节并做一次轻度压缩，与图片内容无关，大图也很快；像素级与混合方式按像素数线性增长，另受全局置换与多轮影响，建议先在小图上确认参数再处理大图。结果区点 <text class="em">[ 性能分析 ]</text> 可看到这批耗时按「密钥派生 / 载荷处理 / 像素处理 / 输出封装」四段的拆分，以及每一张的耗时与占比。</text>
          <text class="p">· 长任务反馈：执行时底部按钮会显示「第几张 / 共几张」与当前阶段（密钥派生 / 载荷处理 / 像素处理 / 输出封装），处理大图时也能看出正在进行哪一步。</text>
          <text class="p">· 排查问题时：打开底部的日志抽屉切到详情，再执行一次——每一步的参数与耗时都会打印出来。</text>
        </view>

        <view v-if="active === 'faq'" class="sec">
          <text class="p">· 输出统一为 PNG（内含私有数据块），经其他编辑器另存、压缩或转格式会丢失数据块，无法还原。</text>
          <text class="p">· 截图与社交软件转发压缩同样会破坏数据；还原必须使用原始输出文件。</text>
          <text class="p">· 本版加密与解密配套：请使用同一版本加密与解密，版本不符时会明确提示，不会静默产出错误结果。</text>
          <text class="p">· 载荷级布局还原的是原始文件本身，原文件的元数据（EXIF / GPS 等）也随之保存在加密载荷中；如需去除元数据，请先清理原图再加密，或改用像素级布局。</text>
          <text class="p">· 合并体积：多图合并的输出体积约等于各原文件之和（原文件多已压缩，二次压缩收益有限），张数越多输出越大。张数上限（{{ TARGET_MIN }}–{{ TARGET_MAX }} 张）、混淆图层数（{{ COVER_MIN }}–{{ COVER_MAX }} 层）与单张像素上限可在「设置 → 批量上限」调整，超限的图像不会载入并在日志中说明原因。</text>
          <text class="p">· 载入与内存：载入图像时只读取尺寸，位图推迟到加密时才按需解码，因此批量载入大图不会因内存不足而失败——只有像素级布局、覆盖合成与混合方式需要真实像素。</text>
          <text class="p">· 混淆图层优先用 PNG：PNG 由内置解码器直接解码，几乎瞬时；JPEG 等格式只能经平台画布解码，而画布受屏幕尺寸限制必须分块，大图层首次参与合成会明显等待（每层只解码一次，之后同一批内不再重复）。</text>
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
