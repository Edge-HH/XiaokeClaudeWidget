import { _electron as electron } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const artifacts = path.resolve('.test-artifacts', String(Date.now()));
await mkdir(artifacts, { recursive: true });
const manifest = JSON.parse(await readFile('vendor/upstream/asset-manifest.json', 'utf8'));
const fixtureAssets = path.resolve('.asset-cache/assets');
await mkdir(fixtureAssets, { recursive: true });
for (const entry of manifest.assets) {
  try { await readFile(path.join(fixtureAssets, entry.name)); } catch {
    // 仅取得固定上游素材作为离线验收基准；测试不访问任何 Claude 账号或模型服务。
    const response = await fetch(entry.url);
    if (!response.ok) throw new Error('无法取得原版测试素材');
    await writeFile(path.join(fixtureAssets, entry.name), Buffer.from(await response.arrayBuffer()));
  }
}
const electronPath = (await import('electron')).default;
const application = await electron.launch({ executablePath: electronPath, args: ['.', '--demo', '--test', '--user-data', path.join(artifacts, 'user-data'), '--fixture-assets', fixtureAssets, '--settings'], timeout: 30_000 });
const watchdog=setTimeout(()=>application.process().kill(),120_000);
application.process().stderr?.on('data', data => { const text = data.toString(); if (text.includes('小克测试初始化失败')) console.log(text); });
const errors = [];
application.on('window', page => { page.on('pageerror', error => errors.push(error.message)); });
async function pageAt(file) {
  for (let i = 0; i < 400; i++) { const page = application.windows().find(page => page.url().endsWith(file)); if (page) return page; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('没有打开 ' + file);
}
try {
  const settings = await pageAt('settings.html');
  const overlay = await pageAt('overlay.html');
  const mock = await pageAt('mock.html');
  await settings.waitForSelector('#source-name');
  await settings.waitForFunction(() => document.getElementById('asset-state').textContent.includes('已就绪'));
  await overlay.waitForSelector('.dshxkv-root');
  await overlay.waitForFunction(() => !!window.__xiaokeDesktop);
  await application.evaluate(async () => { for (let i=0;i<50 && globalThis.__xiaokeTest.helperMode() !== 'mock';i++) await new Promise(resolve=>setTimeout(resolve,100)); });
  assert.equal(await application.evaluate(() => globalThis.__xiaokeTest.helperMode()), 'mock');
  await application.evaluate(()=>globalThis.__xiaokeTest.foreground(true));
  await overlay.waitForFunction(() => window.__xiaokeDesktop.snapshot()?.data?.kind === 'balance');
  assert.match(await settings.locator('#mode-note').innerText(), /模拟模式/);
  const snapshot = await overlay.evaluate(() => window.__xiaokeDesktop.snapshot());
  assert.equal(snapshot.provider, 'deepseek');
  assert.equal(snapshot.data.remaining, 42.5);
  await overlay.evaluate(() => window.__xiaokeDesktop.showBubble());
  await overlay.waitForTimeout(500);
  await overlay.screenshot({ path: path.join(artifacts, 'pet-balance.png') });
  // 原版静态页面只运行固定 JavaScript，不启动 DSH；角色区域与适配版逐像素比较。
  const baselineId = await application.evaluate(async ({ BrowserWindow }) => {
    const pet = BrowserWindow.getAllWindows().find(window => window.getTitle() === '小克额度宠物');
    const baseline = new BrowserWindow({ ...pet.getBounds(), show: false, title: '原版静态基准', frame: false, transparent: true, thickFrame: false, resizable: false, focusable: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await baseline.loadURL('xiaoke://app/test/original.html'); baseline.setIgnoreMouseEvents(true); baseline.showInactive(); return baseline.id;
  });
  const baseline = await pageAt('original.html');
  await baseline.waitForFunction(() => { const image = document.querySelector('.dshxkv-img'); return image?.complete && image.naturalWidth === 610; });
  await overlay.evaluate(() => window.__xiaokeDesktop.hideBubble());
  for(const page of [overlay,baseline]) await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important}.dshxkv-pop{visibility:hidden!important}'});
  // 把尺寸与亚像素起点固定为同一组整数；窗口边缘的 DIP 取整不属于角色造型差异。
  const canonical=await overlay.addStyleTag({content:'.dshxkv-root{--dshxk-base:250px!important;width:250px!important;height:250px!important;left:100px!important;top:100px!important;right:auto!important;bottom:auto!important;transform:none!important}.dshxkv-img{width:150px!important;height:150px!important}'});
  await baseline.addStyleTag({content:'.dshxkv-root{--dshxk-base:250px!important;width:250px!important;height:250px!important;left:100px!important;top:100px!important;right:auto!important;bottom:auto!important;transform:none!important}.dshxkv-img{width:150px!important;height:150px!important}'});
  const petId=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.getTitle()==='小克额度宠物').id);
  async function captureFigure(id,rect){
    const result=await application.evaluate(async({BrowserWindow},input)=>{
      const capture=await BrowserWindow.fromId(input.id).webContents.capturePage({x:Math.round(input.rect.x),y:Math.round(input.rect.y),width:Math.round(input.rect.width),height:Math.round(input.rect.height)},{stayHidden:true,stayAwake:true});
      return capture.toPNG().toString('base64');
    },{id,rect});
    return Buffer.from(result,'base64');
  }
  await application.evaluate(()=>globalThis.__xiaokeTest.pauseAttachment(true));
  const originalPixels=await captureFigure(baselineId,await baseline.locator('.dshxkv-img').boundingBox());
  await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).destroy(), baselineId);
  await application.evaluate(()=>globalThis.__xiaokeTest.pauseAttachment(false));
  const petPixels=await captureFigure(petId,await overlay.locator('.dshxkv-img').boundingBox());
  await writeFile(path.join(artifacts,'pet-reference.png'),originalPixels);
  await writeFile(path.join(artifacts,'pet-adapted.png'),petPixels);
  const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
  assert.equal(hash(petPixels),hash(originalPixels),'角色像素与固定原版不一致');
  await canonical.evaluate(element=>element.remove());
  await writeFile(path.join(artifacts, 'pet-original-match.png'), petPixels);
  await overlay.evaluate(() => window.__xiaokeDesktop.openMenu());
  await overlay.waitForSelector('#desktop-source-button');
  assert.equal(await overlay.locator('.dshxkv-root').count(), 1);
  assert.equal(await overlay.locator('input:disabled').count() > 0, true);
  const settingsRoundTrip = await overlay.evaluate(async () => {
    const read = () => fetch('/dsh-xiaoke/size.json').then(r=>r.json());
    const before = await read();
    const saved = await fetch('/dsh-xiaoke/size.json', { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({...before, scale:1.2}) }).then(r=>r.json());
    const after = await read();
    await fetch('/dsh-xiaoke/size.json', { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify(before) });
    return { saved, after };
  });
  assert.equal(settingsRoundTrip.saved.ok, true); assert.equal(settingsRoundTrip.after.scale, 1.2);
  // 来源配置覆盖 DeepSeek、令牌与账户三个入口；请求都由 mock transport 响应。
  for (const [kind, expected] of [['deepseek', '42.5'], ['newapi-token', '令牌'], ['newapi-account', '账户']]) {
    await settings.locator('#new-source').click();
    await settings.locator('#source-name').fill('离线 ' + kind); await settings.locator('#source-kind').selectOption(kind);
    await settings.locator('#source-secret').fill('mock-secret-only');
    if (kind.startsWith('newapi')) await settings.locator('#base-url').fill('https://example.invalid');
    if (kind === 'newapi-account') await settings.locator('#user-id').fill('123');
    await settings.locator('#save-source').click();
    await settings.waitForFunction(expected => document.getElementById('usage-output').textContent.includes(expected), expected).catch(async () => {
      console.log('来源验收状态：' + JSON.stringify(await settings.evaluate(async () => ({ output: document.getElementById('usage-output').textContent, status: document.getElementById('status').textContent, state: (await window.desktopBridge.state()).value?.snapshot }))));
      throw new Error('来源未显示预期额度：' + kind);
    });
  }
  await settings.screenshot({ path: path.join(artifacts, 'settings.png') });
  await settings.locator('#download-assets').click(); await settings.waitForFunction(() => document.getElementById('status').textContent.includes('测试模式不执行'));
  await settings.locator('#close-settings').click();
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(window => window.getTitle().includes('模拟宿主')).focus(); });
  await overlay.waitForTimeout(300);
  const geometry = await application.evaluate(({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows().find(window => window.getTitle().includes('模拟宿主'));
    const overlay = BrowserWindow.getAllWindows().find(window => window.getTitle() === '小克额度宠物');
    return { host: host.getContentBounds(), overlay: overlay.getBounds(), visible: overlay.isVisible() };
  });
  function aligned(actual, expected) {
    assert.equal(actual.x, expected.x); assert.equal(actual.y, expected.y);
    // Win32 客户区含 Electron 框架内边缘，且物理像素/DIP 边缘取整可能产生额外 1 DIP。
    assert.ok(Math.abs(actual.width - expected.width) <= 3); assert.ok(Math.abs(actual.height - expected.height) <= 3);
  }
  assert.equal(geometry.visible, true); aligned(geometry.overlay, geometry.host);
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(window => window.getTitle().includes('模拟宿主')).setBounds({ x: 120, y: 100, width: 850, height: 600 }); });
  await overlay.waitForTimeout(400);
  const resized = await application.evaluate(({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows().find(window => window.getTitle().includes('模拟宿主'));
    const pet = BrowserWindow.getAllWindows().find(window => window.getTitle() === '小克额度宠物'); return { host: host.getContentBounds(), pet: pet.getBounds() };
  });
  console.log('模拟宿主缩放边界：' + JSON.stringify(resized));
  aligned(resized.pet, resized.host);
  await overlay.evaluate(() => { window.__xiaokeDesktop.closeMenu(); window.__xiaokeDesktop.hideBubble(); });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window=>window.getTitle().includes('模拟宿主')).focus());
  let nativeInputAvailable=true;
  try { await application.evaluate(()=>globalThis.__xiaokeTest.input('focus',{x:0,y:0})); }
  catch { nativeInputAvailable=false; console.log('Windows 前台锁定：以真实窗口样式和模拟页面输入验证穿透，不发送系统鼠标输入。'); }
  const blank = await mock.locator('#mock-counter').boundingBox();
  const origin = await application.evaluate(({ BrowserWindow })=>BrowserWindow.getAllWindows().find(window=>window.getTitle().includes('模拟宿主')).getContentBounds());
  const counterPoint = {x:origin.x+blank.x+blank.width/2,y:origin.y+blank.y+blank.height/2};
  await application.evaluate(()=>globalThis.__xiaokeTest.pointer({x:0,y:0})); await overlay.waitForTimeout(150);
  assert.equal((await application.evaluate(()=>globalThis.__xiaokeTest.mouseStyle())).transparent,true);
  if(nativeInputAvailable){
    await application.evaluate((_,point)=>globalThis.__xiaokeTest.input('move',point),counterPoint); await overlay.waitForTimeout(300);
    await application.evaluate((_,point)=>globalThis.__xiaokeTest.input('click',point),counterPoint);
  } else await mock.locator('#mock-counter').click();
  await mock.waitForFunction(()=>document.getElementById('mock-counter').textContent.includes('1'));
  const petPoint = await overlay.evaluate(()=>{
    const rect=document.querySelector('.dshxkv-img').getBoundingClientRect();
    for(let y=rect.top+10;y<rect.bottom;y+=10) for(let x=rect.left+10;x<rect.right;x+=10) if(window.__xiaokeDesktop.isHit({clientX:x,clientY:y})) return {x,y};
  });
  const petOrigin = await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.getTitle()==='小克额度宠物').getBounds());
  const opaquePoint={x:petOrigin.x+petPoint.x,y:petOrigin.y+petPoint.y};
  await application.evaluate((_,point)=>globalThis.__xiaokeTest.pointer(point),petPoint); await overlay.waitForTimeout(150);
  assert.equal((await application.evaluate(()=>globalThis.__xiaokeTest.mouseStyle())).transparent,false);
  if(nativeInputAvailable){
    await application.evaluate((_,point)=>globalThis.__xiaokeTest.input('move',point),opaquePoint); await overlay.waitForTimeout(300);
    await application.evaluate((_,point)=>globalThis.__xiaokeTest.input('right-click',point),opaquePoint);
  } else await overlay.mouse.click(petPoint.x,petPoint.y,{button:'right'});
  await overlay.waitForSelector('.dshxkv-menu-open');
  await overlay.evaluate(() => { window.__xiaokeDesktop.openResources(); });
  await overlay.waitForTimeout(400);
  await overlay.screenshot({ path: path.join(artifacts, 'resources.png') });
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(window => window.getTitle().includes('模拟宿主')).minimize(); });
  await overlay.waitForTimeout(400);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === '小克额度宠物').isVisible()), false);
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ passed: true, nativeHelperMode: 'mock', queryMode: 'mock', realClaudeQueries: false, originalPetPixelMatch: true, nativeMouseStyles: true, actualSystemMouseInput: nativeInputAvailable, foregroundFixtures:true, petContextMenu: true, settingsRoundTrip: true, errors, screenshots: ['pet-subscription.png', 'pet-original-match.png', 'settings.png', 'resources.png'], geometry, resized }, null, 2));
  console.log('离线桌面验收通过：' + artifacts);
} finally { clearTimeout(watchdog); await application.evaluate(({app})=>app.quit()).catch(()=>{}); await application.close().catch(()=>{}); }
