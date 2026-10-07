var count = 0;
document.getElementById('mock-counter').addEventListener('click', function () { count++; this.textContent = '点击穿透测试：' + count; });
document.getElementById('mock-settings').addEventListener('click', function () { window.desktopBridge.openSettings(); });
