import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

// 全程只使用本项目模拟宿主和 DeepSeek 模拟余额，不连接任何真实查询服务。
const directory = path.resolve('.test-artifacts', 'process-recovery-' + Date.now());
const packed = process.argv.includes('--package');
await mkdir(directory, { recursive: true });
const application = await electron.launch({
  ...(packed ? { executablePath: path.resolve('release/win-unpacked/XiaokeWidget.exe') } : {}),
  args: [...(packed ? [] : ['.']), '--demo', '--test', '--user-data', directory, '--fixture-assets', path.resolve('.asset-cache/assets')], timeout: 30_000,
});
const watchdog = setTimeout(() => application.process().kill(), 45_000);
async function waitForVisible() {
  return application.evaluate(async ({ BrowserWindow }) => {
    for (let i = 0; i < 100; i++) {
      const pet = BrowserWindow.getAllWindows().find(window => window.getTitle() === '小克额度宠物');
      if (pet?.isVisible() && !pet.webContents.isLoading()) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  });
}
try {
  await application.evaluate(async () => {
    for (let i = 0; i < 100 && globalThis.__xiaokeTest?.helperMode() !== 'mock'; i++) await new Promise(resolve => setTimeout(resolve, 50));
    globalThis.__xiaokeTest.foreground(true);
  });
  assert.equal(await application.evaluate(() => globalThis.__xiaokeTest.helperMode()), 'mock');
  assert.equal(await waitForVisible(), true, '模拟宿主上的宠物必须先显示');
  await application.evaluate(({ BrowserWindow }) => {
    const pet = BrowserWindow.getAllWindows().find(window => window.getTitle() === '小克额度宠物');
    pet.webContents.forcefullyCrashRenderer();
  });
  // 给 render-process-gone 消息先送达，再判断窗口是否完成自动恢复。
  await application.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(await waitForVisible(), true, '宠物渲染进程崩溃后必须自动重载并重新显示');
  // Playwright 的旧 Page 在崩溃后永久标记 crashed；从重建的 webContents 验收新文档。
  const recovered = await application.evaluate(async ({ BrowserWindow }) => {
    const pet = BrowserWindow.getAllWindows().find(window => window.getTitle() === '小克额度宠物');
    for (let i = 0; i < 100; i++) {
      const snapshot = await pet.webContents.executeJavaScript('window.__xiaokeDesktop?.snapshot()').catch(() => null);
      if (snapshot?.provider === 'deepseek' && snapshot?.data?.kind === 'balance') return snapshot;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return null;
  });
  assert.equal(recovered?.data?.kind, 'balance', '自动恢复后桌面桥接必须重新接收 DeepSeek 模拟余额');
  await application.evaluate(() => globalThis.__xiaokeTest.input('exit', { x: 0, y: 0 }));
  await application.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(await waitForVisible(), true, '模拟窗口辅助组件意外退出后必须自动重启并恢复宠物');
  assert.equal(await application.evaluate(() => globalThis.__xiaokeTest.helperMode()), 'mock');
  console.log('渲染进程崩溃和模拟窗口辅助组件退出后均自动恢复：通过；仅使用模拟宿主及 DeepSeek 模拟余额。');
} finally {
  await application.evaluate(({ app }) => app.quit()).catch(() => {});
  await application.close().catch(() => {});
  clearTimeout(watchdog);
}
