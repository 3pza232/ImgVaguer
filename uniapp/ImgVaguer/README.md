# ImgVaguer（移动端 · uni-app）

图片加密混淆与还原工具的移动端版本：一套代码覆盖 **H5 / App（Android、iOS）/ 微信小程序**。
与桌面版（`../../`，Electron）共用同一套加密格式与算法，两端产物**双向兼容**。

## 与桌面版的关系

- 加密格式、算法与元数据布局完全一致：PNG 私有数据块（`inVa`）+ ChaCha20 密钥流 / PBKDF2-SHA256 / HMAC-SHA256，逐位无损还原。
- 业务结构对齐桌面版（`core` / `services` / `stores`），差异仅收敛在三处平台适配：**选文件、读字节、导出**。
- 本工程为 **HBuilderX 工程，零 npm 运行时依赖**：`fflate` 以单文件 ESM 随包分发（`libs/fflate.js`），随机源、画布解码、文件读写按平台分支实现。

## 运行与构建

用 HBuilderX 打开本目录即可，无需 `npm install`：

- **运行到浏览器**：H5 调试
- **运行到手机或模拟器**：App（打包发布前在 `manifest.json` 配置 AppID 与签名）
- **运行到小程序模拟器**：微信开发者工具（需在 `manifest.json` 填入 `mp-weixin.appid`）

## 目录结构

```
core/        纯 TS 算法层（无平台依赖）：chacha / hash / kdf / scramble / overlay / png / pack / header / keyfile / resize / random / base64 / text / image-format / storage-path
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
- **无 Web Crypto 时**：KDF / HMAC / SHA-256 走内置纯 TS 实现，输出与原生路径逐位一致。

## 版本

当前 **0.2.1**。版本号在两处维护且需保持一致：`app-meta.ts` 的 `APP_VERSION` 与 `manifest.json` 的 `versionName` / `versionCode`。

## 文档

应用内：**设置 → 打开使用文档**（快速上手 / 混淆方式 / 保护方式 / 参数 / 安全模型 / 强度评估 / 使用建议 / 注意事项）。

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
