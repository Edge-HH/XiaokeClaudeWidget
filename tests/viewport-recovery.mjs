import { _electron as electron } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const artifacts = path.resolve('.test-artifacts', 'viewport-recovery-' + Date.now());
const packed = process.argv.includes('--package');
await mkdir(artifacts, { recursive: true });
const application = await electron.launch({
  ...(packed ? { executablePath: path.resolve('release/win-unpacked/XiaokeWidget.exe') } : {}),
  args: [...(packed ? [] : ['.']), '--demo', '--test', '--user-data', artifacts, '--fixture-assets', path.resolve('.asset-cache/assets')],
  timeout: 30000,
});
const watchdog = setTimeout(() => application.process().kill(), 30000);
try {
  await application.evaluate(async () => {
    for (let i = 0; i < 100 && !globalThis.__xiaokeTest?.host(); i++) await new Promise(resolve => setTimeout(resolve, 50));
    globalThis.__xiaokeTest.foreground(true);
  });
  const page = application.windows().find(page => page.url().endsWith('overlay.html'));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle().includes('模拟宿主')).setContentBounds({ x: 0, y: 0, width: 1707, height: 1019 }));
  await page.evaluate(() => fetch('/dsh-xiaoke/size.json', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scale: 1.3, sound: false }) }));
  await page.addInitScript(() => {
    const add = window.addEventListener.bind(window);
    window.addEventListener = function (type, listener, options) {
      if (type === 'resize') return add(type, function (event) {
        if (!window.__dropResize) {
          if (typeof listener === 'function') listener.call(window, event);
          else listener.handleEvent(event);
        }
      }, options);
      return add(type, listener, options);
    };
  });
  await page.reload();
  await page.waitForFunction(() => !!window.__xiaokeDesktop && document.querySelector('.dshxkv-img')?.naturalWidth > 0);
  await page.waitForTimeout(700);
  const before = await page.locator('.dshxkv-img').boundingBox();
  // Replay the observed failure: the native client shrinks but the pet keeps the old
  // maximized position. A dropped resize notification must not make it unrecoverable.
  await page.evaluate(() => { window.__dropResize = true; });
  await application.evaluate(() => globalThis.__xiaokeTest.foreground(false));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle().includes('模拟宿主')).setContentBounds({ x: 170, y: 37, width: 1366, height: 892 }));
  await application.evaluate(() => globalThis.__xiaokeTest.trayCycle());
  await application.evaluate(() => globalThis.__xiaokeTest.foreground(true));
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => ({
    viewport: [innerWidth, innerHeight],
    rect: document.querySelector('.dshxkv-img').getBoundingClientRect().toJSON(),
  }));
  console.log('重放旧坐标与较小窗口：' + JSON.stringify({ before, after }));
  assert.ok(after.rect.right <= after.viewport[0] + 2 && after.rect.bottom <= after.viewport[1] + 2, 'The pet must recover inside the smaller client after tray dismissal, even when resize was dropped');
  const point = await page.evaluate(() => {
    const rect = document.querySelector('.dshxkv-img').getBoundingClientRect();
    for (let y = rect.top + 10; y < rect.bottom; y += 10) for (let x = rect.left + 10; x < rect.right; x += 10) {
      if (window.__xiaokeDesktop.isHit({ clientX: x, clientY: y })) return { x, y };
    }
  });
  assert.ok(point, 'The recovered pet must have an opaque region that can start a drag');
  const rootBeforeDrag = await page.locator('.dshxkv-root').boundingBox();
  await application.evaluate((_, point) => globalThis.__xiaokeTest.pointer(point), point);
  await page.waitForTimeout(100);
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x - 350, point.y - 240, { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(350);
  const anchor = await page.evaluate(() => JSON.parse(localStorage.getItem('dshxk-pos')));
  assert.equal(anchor.v, 2); assert.ok(anchor.hDist >= 0 && anchor.vDist >= 0);
  const rootBeforeReload = await page.locator('.dshxkv-root').boundingBox();
  assert.ok(rootBeforeReload.x < rootBeforeDrag.x - 200 && rootBeforeReload.y < rootBeforeDrag.y - 150, 'The recovery guard must allow dragging away from the edge');
  await page.reload();
  await page.waitForFunction(() => !!window.__xiaokeDesktop && document.querySelector('.dshxkv-img')?.naturalWidth > 0);
  await page.waitForTimeout(700);
  const rootAfterReload = await page.locator('.dshxkv-root').boundingBox();
  assert.ok(Math.abs(rootAfterReload.x - rootBeforeReload.x) <= 2 && Math.abs(rootAfterReload.y - rootBeforeReload.y) <= 2, 'The saved position must survive recovery and reload');
  console.log('托盘恢复后的宠物边界检查通过');
} finally {
  try { await application.evaluate(({ app }) => app.quit()).catch(() => {}); await application.close().catch(() => {}); }
  finally { clearTimeout(watchdog); }
}
