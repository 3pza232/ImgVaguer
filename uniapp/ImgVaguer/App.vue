<script>
/**
 * 应用入口：启动时安装随机源（小程序异步 CSPRNG 池化）并预热。
 * 采用选项式写法以免依赖 @dcloudio/uni-app 包（HBuilderX 工程零 npm 依赖）。
 */
import { installRandom } from '@/services/platform/random-pool';

export default {
  onLaunch() {
    // 仅安装提供者；真正取用前由 ensureRandomReady() 等待渲染层注入随机（见工作台页）
    installRandom();
  },
};
</script>

<style>
/* 复古 TUI 主题令牌：与桌面版同源，尺寸改为 rpx 触屏尺度 */
page {
  --bg: #0b0e0b;
  --panel: #10150f;
  --sunken: #0c110c;
  --line: #243020;
  --line-hi: #3a4f33;
  --fg: #b3c4a6;
  --dim: #66795c;
  --acc: #93c572;
  --warn: #d8b26a;
  --err: #d97a6c;

  background: #0b0e0b;
  color: #b3c4a6;
  font-family: "IBM Plex Mono", ui-monospace, "Courier New", monospace;
  font-size: 28rpx;
  line-height: 1.5;
}

/*
 * 统一盒模型：uni 组件默认 content-box，`width: 100%` 叠加 padding/边框
 * 会撑破父容器（表现为右边界溢出），此处收敛为 border-box。
 * 仅作用于布局容器与图像：input/textarea 在 App 端为原生输入层，
 * 保持其默认盒模型，避免干扰原生控件的命中区域。
 */
page,
view,
scroll-view,
image {
  box-sizing: border-box;
}

/* #ifdef H5 */
:root {
  --bg: #0b0e0b;
  --panel: #10150f;
  --sunken: #0c110c;
  --line: #243020;
  --line-hi: #3a4f33;
  --fg: #b3c4a6;
  --dim: #66795c;
  --acc: #93c572;
  --warn: #d8b26a;
  --err: #d97a6c;
}

/* H5 滚动条主题化；App/小程序为原生滚动条无法换肤，改用 scroll-view 隐藏 */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: var(--line-hi);
  border: 2px solid var(--panel);
}
::-webkit-scrollbar-thumb:hover {
  background: var(--acc);
}
/* #endif */
</style>
