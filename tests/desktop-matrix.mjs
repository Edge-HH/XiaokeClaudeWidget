import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const packed=process.argv.includes('--package');
const executable=packed ? path.resolve('release/win-unpacked/XiaokeWidget.exe') : (await import('electron')).default;
const root=path.resolve('.test-artifacts','matrix-'+Date.now()); await mkdir(root,{recursive:true});
const results=[];
for(const scale of packed ? [1] : [1,1.5,2]){
  const app=await electron.launch({executablePath:executable,args:[...(packed?[]:['.']),'--demo','--test','--force-device-scale-factor='+scale,'--user-data',path.join(root,'scale-'+scale),'--fixture-assets',path.resolve('.asset-cache/assets')],timeout:30000});
  const watchdog=setTimeout(()=>app.process().kill(),60000);
  try{
    await app.evaluate(async()=>{for(let i=0;i<100 && !globalThis.__xiaokeTest?.host();i++) await new Promise(resolve=>setTimeout(resolve,100));});
    const info=await app.evaluate(()=>({mode:globalThis.__xiaokeTest.helperMode(),query:globalThis.__xiaokeTest.queryMode}));
    assert.equal(info.mode,'mock'); assert.equal(info.query,'mock');
    await app.evaluate(()=>globalThis.__xiaokeTest.foreground(true));
    const page=app.windows().find(page=>page.url().endsWith('overlay.html'));
    await page.waitForFunction(()=>window.__xiaokeDesktop?.snapshot()?.data?.kind==='subscription');
    assert.equal(await page.evaluate(()=>window.devicePixelRatio),scale);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle().includes('模拟宿主')).setBounds({x:80,y:70,width:900,height:640}));
    await page.waitForTimeout(1200);
    const geometry=await app.evaluate(({BrowserWindow})=>{const host=BrowserWindow.getAllWindows().find(w=>w.getTitle().includes('模拟宿主'));const pet=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='小克额度宠物');return {host:host.getContentBounds(),pet:pet.getBounds(),visible:pet.isVisible(),hwnd:host.getNativeWindowHandle().readBigUInt64LE().toString()};});
    console.log('缩放 '+scale+' 边界：'+JSON.stringify({geometry,native:await app.evaluate(()=>globalThis.__xiaokeTest.host())}));
    assert.equal(geometry.visible,true);assert.ok(Math.abs(geometry.host.x-geometry.pet.x)<=1);assert.ok(Math.abs(geometry.host.y-geometry.pet.y)<=1);assert.ok(Math.abs(geometry.host.width-geometry.pet.width)<=4);assert.ok(Math.abs(geometry.host.height-geometry.pet.height)<=4);
    await app.evaluate(()=>globalThis.__xiaokeTest.foreground(false)); await page.waitForTimeout(150);
    assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='小克额度宠物').isVisible()),false);
    await app.evaluate(()=>globalThis.__xiaokeTest.foreground(true));
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle().includes('模拟宿主')).maximize()); await page.waitForTimeout(300);
    assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='小克额度宠物').isVisible()),true);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle().includes('模拟宿主')).minimize()); await page.waitForTimeout(300);
    assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='小克额度宠物').isVisible()),false);
    await app.evaluate(({BrowserWindow})=>{const host=BrowserWindow.getAllWindows().find(w=>w.getTitle().includes('模拟宿主'));host.restore();host.close();}); await page.waitForTimeout(300);
    assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='小克额度宠物').isVisible()),false);
    results.push({scale,packed,geometry,foregroundFixtures:true,closedHostHidden:true});
    console.log((packed?'打包成品':'模拟缩放')+' '+scale*100+'% 验收通过');
  }finally{clearTimeout(watchdog);await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
}
await writeFile(path.join(root,'result.json'),JSON.stringify(results,null,2));
console.log('矩阵记录：'+root);
