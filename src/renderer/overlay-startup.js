// 独立于原版初始化安装失败通知；只发送固定状态，不传异常文本、路径或配置。
window.addEventListener('xiaoke:init-failed', () => window.desktopBridge?.rendererFailed());
window.addEventListener('error', event => {
  if (event.target === window) window.desktopBridge?.rendererFailed();
});
