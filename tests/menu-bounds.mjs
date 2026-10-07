import { _electron as electron } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const packed = process.argv.includes('--package');
const directory = path.resolve('.test-artifacts', 'menu-bounds-' + Date.now());
await mkdir(directory, { recursive: true });
const application = await electron.launch({
  ...(packed ? { executablePath: path.resolve('release/win-unpacked/XiaokeWidget.exe') } : {}),
  args: [...(packed ? [] : ['.']), '--demo', '--test', '--user-data', directory, '--fixture-assets', path.resolve('.asset-cache/assets')],
  timeout: 30_000,
});
const watchdog = setTimeout(() => application.process().kill(), 45_000);
try {
  await application.evaluate(async () => {
    for (let i = 0; i < 100 && !globalThis.__xiaokeTest?.host(); i++) await new Promise(resolve => setTimeout(resolve, 50));
    globalThis.__xiaokeTest.foreground(true);
  });
  const page = application.windows().find(window => window.url().endsWith('overlay.html'));
  await page.waitForFunction(() => window.__xiaokeDesktop?.snapshot()?.provider === 'deepseek');
  await page.addStyleTag({ content: '.dshxkv-root{left:12px!important;top:12px!important;right:auto!important;bottom:auto!important;transform:none!important}' });
  for (const [width, height] of [[900, 700], [440, 330]]) {
    await application.evaluate(({ BrowserWindow }, dimensions) => {
      BrowserWindow.getAllWindows().find(window => window.getTitle().includes('模拟宿主')).setContentSize(...dimensions);
    }, [width, height]);
    await page.waitForTimeout(250);
    await page.evaluate(() => window.__xiaokeDesktop.openMenu());
    await page.waitForSelector('.dshxkv-menu-open');
    const geometry = await page.evaluate(() => ({
      menu: document.querySelector('.dshxkv-menu').getBoundingClientRect().toJSON(),
      viewport: { width: innerWidth, height: innerHeight },
    }));
    assert.ok(geometry.menu.left >= 0 && geometry.menu.top >= 0, '顶部菜单必须留在宿主客户区内');
    assert.ok(geometry.menu.right <= geometry.viewport.width + 1 && geometry.menu.bottom <= geometry.viewport.height + 1, '小宿主内菜单须限宽限高并可滚动');
    await page.locator('#desktop-source-button').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, `menu-${width}x${height}.png`) });
    await page.locator('#desktop-source-button').click();
    await page.waitForTimeout(200);
    const settings = application.windows().find(window => window.url().endsWith('settings.html'));
    assert.ok(settings, '位于顶部的查询来源按钮必须可用');
    await settings.waitForSelector('#close-settings');
    await settings.locator('#close-settings').click();
    await page.evaluate(() => window.__xiaokeDesktop.closeMenu());
  }
  console.log('顶部宠物与小宿主菜单边界、查询来源按钮交互验收通过：' + directory);
} finally {
  await application.evaluate(({ app }) => app.quit()).catch(() => {});
  await application.close().catch(() => {});
  clearTimeout(watchdog);
}
