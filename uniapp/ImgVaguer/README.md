# ImgVaguer（移动端 · uni-app）

图片加密混淆与还原工具的移动端版本：一套代码覆盖 **H5 / App（Android、iOS）/ 微信小程序**。
与桌面版（`../../`，Electron）共用同一套加密格式与算法，两端产物**双向兼容**。

## 与桌面版的关系

- 加密格式、算法与元数据布局完全一致：PNG 私有数据块（`inVa`）+ ChaCha20 密钥流 / PBKDF2-SHA256（口令）/ HKDF-SHA256（全熵种子）/ HMAC-SHA256；载荷级布局解密即还原原文件，像素级布局逐位还原像素。
- 业务结构对齐桌面版（`core` / `services` / `stores`），差异仅收敛在三处平台适配：**选文件、读字节、导出**。
- 本工程为 **HBuilderX 工程，零 npm 运行时依赖**：`fflate` 以单文件 ESM 随包分发（`libs/fflate.js`），随机源、画布解码、文件读写按平台分支实现。

## 运行与构建

用 HBuilderX 打开本目录即可，无需 `npm install`：

- **运行到浏览器**：H5 调试
- **运行到手机或模拟器**：App（打包发布前在 `manifest.json` 配置 AppID 与签名）
- **运行到小程序模拟器**：微信开发者工具（需在 `manifest.json` 填入 `mp-weixin.appid`）

## 目录结构

```
core/        纯 TS 算法层（无平台依赖）：chacha / hash / kdf / scramble / decoy / overlay / png / pack / header / keyfile / resize / random / base64 / text / image-format / storage-path
services/    编排层：engine（加解密）、actions（用户动作）、export（App 导出通道）
  platform/  平台适配：image-io（选图/解码/预览）、save（非 App 导出）、app-storage（导出目录选取与字节落盘）、app-picker（系统文件选择：密钥文件）、app-intent（Intent 与结果分发）、random-pool（随机源池化）、storage（设置持久化）、canvas-box（隐藏画布尺寸桥）、system（安全区）
components/  TUI 组件：堆叠预览、放大浮层、缩略图条、分段选择、开关、折叠分组、日志抽屉、使用文档面板
pages/       页面：index（工作台）、settings（设置）
stores/      响应式会话状态与设置持久化（session）、放大预览状态（zoom）
libs/        fflate 单文件 ESM 及其类型声明
types/       全局类型声明（uni / wx / plus）
```

## 平台差异

- **存储位置（App）**：设置页点「选择文件夹」，经系统「打开方式」进入文件夹选择器自选任意目录（SAF，授权持久化）；**首次导出**若尚未选择会先提示并拉起选择器，选定后自动继续。导出文件直接写入所选文件夹。
- **密钥文件载入（App）**：经系统「打开方式」交由用户指定应用，默认打开到所选存储文件夹（`EXTRA_INITIAL_URI`，API 26+）；选中的文档**反解为真实路径**（`core/storage-path`）后由 plus.io 读取，再转存到应用私有目录。
- **Native.js 约束（App，改前必读）**：四条都已踩坑并写入回归守卫（`tests/uniapp-components.test.ts`）——
  ① `ContentResolver` 这类**手工取回的实例**，其方法名在 JS 侧并不存在，直接 `res.openInputStream(uri)` 会抛 `e.openInputStream is not a function`（`e` 是打包压缩后的变量名），必须经 `plus.android.invoke`（封装见 `platform/app-intent.ts` 的 `callJava`）；
  ② 不取用 `query` / `DocumentsContract` / `openOutputStream`（重载桥接不可靠）；
  ③ **不做 Native.js 字节搬运**：`java.nio` 的 `Files.copy(InputStream, Path)` 不可用，`InputStream.read(byte[])` 的数组出参不回填（读到的恒为 0，写盘只会得到全零文件）。读写一律「URI 反解真实路径 + `java.io` / plus.io」；
  ④ 私有目录临时路径**必须由 plus.io 给出**（`requestFileSystem` + `getFile` + `toLocalURL`），自行用 `convertLocalFileSystemURL('_doc/') + 文件名` 拼接会落到进程工作目录，表现为写入"成功"、读取报「文件不存在」。
- **导出（App）**：tree URI 反解为**真实路径**后用 `java.io.FileOutputStream` 写入——**不经解码或转码**，写后核对落盘尺寸才提示成功；同名文件直接覆盖，文件名与界面所填一致。（不用 `ContentResolver.query` / `DocumentsContract`：其重载在 Native.js 下桥接不可靠。）
- **导出（H5 / 小程序）**：H5 为浏览器下载；小程序保存到系统相册。
- **密钥文件（`.ivkey`）**：文件名严格采用导出面板中所填内容，写入所选文件夹。App 端载入密钥有两条通道：**从文件载入**（系统文件选择）与**剪贴板**；H5 走文件选择，小程序用剪贴板。
- **选图**：统一走系统相册（H5 为文件选择框），不弹来源面板——App 端从文件夹取图需额外存储读权限且系统不主动询问，故不提供该通道；需要选择本地文件时用密钥载入或 H5 端的文件选择。
- **随机源**：H5 / App 用 Web Crypto；小程序仅有异步接口，启动时池化预取，取用不足即显式报错，绝不退化为弱随机。
- **图像解码**：优先自研 PNG 解码器（逐位精确）；非 PNG 输入回退平台画布——H5 / App 用 DOM canvas，小程序用 canvas 2d 节点（**图像边长上限 4096px**）。
- **无 Web Crypto 时**：KDF / HMAC / SHA-256 走内置纯 TS 实现，输出与原生路径逐位一致（两套实现经官方向量与交叉验证，见 `../../tests/hash.test.ts`）。该路径按"每轮只做必要压缩、全程复用缓冲"实现，并按固定间隔让出主线程，避免长迭代冻结界面。
- **核心层不引用宿主全局**：UTF-8 与 Base64 均为纯 TS 实现（`core/text.ts`、`core/base64.ts`），`core/` 内一律不出现 `TextEncoder` / `TextDecoder` / `btoa` / `atob`——App（5+）与部分小程序 runtime 不提供它们，误用只会在真机上报 `ReferenceError`。`npm run check:uniapp` 会在打包前拦截这类引用。
- **性能取向**：移动端默认使用密文混淆的**载荷级**布局——原图以原始文件字节加密存放，只做一次轻度压缩，不再逐像素变换；输出体积与原文件相当，耗时也远低于像素级。
- **按需解码**：选图阶段只探测尺寸（`probeImage`），位图在加密时才解码（`decodeRaster`），且载荷布局与多图合并根本不触发解码；因此批量载入大图既不慢也不吃内存。张数（1–4）、混淆图层（1–3 层）与单张像素上限可在设置中调整。
- **画布上限（改代码前必读）**：非 PNG 图像只能由平台画布解码，而原生画布（App / 小程序）的绘图区不超过屏幕——整幅绘制时超出部分直接丢失，读回只剩左上角一块。因此解码必须按屏幕尺寸分块，且画布尺寸只设定一次、全程复用（逐块重建会落到旧绘图区）。同理，预览一律直接用原图路径，不要再为预览解码编码一遍。
- **由此产生的性能特征**：PNG 走内置解码器，瞬时完成；JPEG 等格式按屏幕分块解码，耗时与像素量成正比（一张 12MP 照片约需数十次分块绘制），故大尺寸混淆图层首次合成会有明显等待，且每层只解一次。需要更快时首选 PNG 图层。
- **还原结果预览**：载荷级布局还原的是原始文件（可能是 jpg / webp 等），无法再由位图重新编码，故 H5 用 Blob URL、App 写入应用私有目录、小程序写入用户目录后按路径预览。

## 版本

当前 **0.3.1**。版本号在两处维护且需保持一致：`app-meta.ts` 的 `APP_VERSION` 与 `manifest.json` 的 `versionName` / `versionCode`。

批量上限区间由 `stores/session.ts` 的 `TARGET_MIN` / `TARGET_MAX` / `COVER_MIN` / `COVER_MAX` 定义，设置界面与使用文档均引用这些常量，改档位只需改常量。

## 文档

应用内：**设置 → 打开使用文档**（快速上手 / 名词解释 / 混淆方式 / 保护方式 / 参数 / 安全模型 / 强度评估 / 使用建议 / 注意事项）。

## 质量校验

工程本身零 npm 依赖，校验脚本在仓库根目录（`../../`）：

```bash
npm run check:uniapp   # 三平台（h5 / mp-weixin / app-plus）条件编译后跑 vue-tsc --strict，零错误
npm test               # Node 侧回归：SFC 结构与模板可编译、组件 setup 真实执行、core 纯逻辑
```

`tests/uniapp-components.test.ts` 另含 **Native.js 约束守卫**（见上「Native.js 约束」四条），
这些坑只有真机才暴露，静态类型检查查不出来，故以源码扫描形式固化。

## 注意

- 输出为 PNG 且内含私有数据块，**经其他编辑器另存、压缩或转格式会丢失数据块**，导致无法还原；传输请使用原始文件。
- 口令与密钥文件一旦丢失即无法还原；「默认口令」以明文存于本机存储，公共设备请勿使用。

---

by pza
