import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

// Use only our mock host and mock usage. No Claude process or real account is involved.
const root = path.resolve('.test-artifacts', 'lifecycle-' + Date.now());
const packed = process.argv.includes('--package');
await mkdir(root, { recursive: true });
const application = await electron.launch({
  ...(packed ? { executablePath: path.resolve('release/win-unpacked/XiaokeWidget.exe') } : {}),
  args: [...(packed ? [] : ['.']), '--demo', '--test', '--user-data', root],
  timeout: 30000,
});
const watchdog = setTimeout(() => application.process().kill(), 30000);
try {
  await application.evaluate(async () => {
    for (let i = 0; i < 100 && !globalThis.__xiaokeTest?.host(); i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    globalThis.__xiaokeTest.foreground(true);
  });
  const overlay = application.windows().find(page => page.url().endsWith('overlay.html'));
  assert.ok(overlay, 'The mock pet window must exist');
  await overlay.waitForTimeout(150);
  await application.evaluate(({ BrowserWindow }) => {
    globalThis.__lifecycleErrors = [];
    // Capture the exact exception without opening a disruptive OS error dialog.
    process.on('uncaughtException', error => globalThis.__lifecycleErrors.push({
      name: error.name, message: error.message,
      stack: error.stack?.split('\n').filter(line => line.includes('/dist/main/')),
    }));
    const pet = BrowserWindow.getAllWindows().find(window => window.getTitle() === '小克额度宠物');
    if (!pet?.isVisible()) throw new Error('The pointer timer must be active for this regression');
    pet.destroy();
  });
  const errors = await application.evaluate(async () => {
    await new Promise(resolve => setTimeout(resolve, 180));
    return globalThis.__lifecycleErrors;
  });
  assert.deepEqual(errors, [], 'Destroying the pet must not cause repeated main-process error dialogs');
  // A pending host update or settings blur can run after the pet has gone away.
  await application.evaluate(({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows().find(window => window.getTitle().includes('模拟宿主'));
    host.setBounds({ x: 100, y: 100, width: 880, height: 600 });
  });
  await application.evaluate(async () => {
    await new Promise(resolve => setTimeout(resolve, 150));
  });
  await application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
  });
  const finalErrors = await application.evaluate(async () => {
    await new Promise(resolve => setTimeout(resolve, 180));
    return globalThis.__lifecycleErrors;
  });
  assert.deepEqual(finalErrors, [], 'Late callbacks after all windows close must not open error dialogs');
  console.log('窗口销毁后没有重复的主进程异常：通过');
} finally {
  try {
    await application.evaluate(({ app }) => app.quit()).catch(() => {});
    await application.close().catch(() => {});
  } finally {
    clearTimeout(watchdog);
  }
}
