/** 设置持久化：统一走 uni 存储 API（H5 底层即 localStorage） */
export function getItem(key: string): string | null {
  try {
    const v = uni.getStorageSync(key);
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

export function setItem(key: string, value: string): void {
  try {
    uni.setStorageSync(key, value);
  } catch {
    // 容量不足（如默认混淆图过大）时静默失败，不影响本次使用
  }
}
