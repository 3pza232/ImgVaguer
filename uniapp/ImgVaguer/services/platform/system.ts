/**
 * 系统信息适配：顶部安全距离（px）。
 * 自定义导航栏下内容会顶到屏幕最上方，需按状态栏高度下移。
 * App 仅在「沉浸式状态栏」时才需补偿；非沉浸式时系统已预留空间，补偿会造成双重留白。
 */

export function topInset(): number {
  // #ifdef APP-PLUS
  try {
    return plus.navigator.isImmersedStatusbar() ? plus.navigator.getStatusbarHeight() : 0;
  } catch {
    return 0;
  }
  // #endif
  // #ifdef MP-WEIXIN
  return uni.getSystemInfoSync().statusBarHeight ?? 0;
  // #endif
  // #ifdef H5
  return 0;
  // #endif
}
