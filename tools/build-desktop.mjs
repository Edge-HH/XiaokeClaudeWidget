import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

const upstream = 'vendor/upstream';
const manifest = JSON.parse(await readFile(`${upstream}/source-manifest.json`, 'utf8'));
for (const [file, hash] of Object.entries(manifest.files)) {
  if (createHash('sha256').update(await readFile(`${upstream}/${file}`)).digest('hex') !== hash) throw new Error(`固定原版代码已改变：${file}`);
}
function replaceOnce(source, needle, replacement) {
  if (source.split(needle).length !== 2) throw new Error(`适配锚点不唯一：${needle.slice(0, 90)}`);
  return source.replace(needle, replacement);
}
// 使用语法树定位函数，避免以正则匹配大括号破坏原版模板字符串或嵌套函数。
function replaceFunction(source, name, body) {
  const tree = ts.createSourceFile('upstream.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found;
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) { if (found) throw new Error(`函数锚点重复：${name}`); found = node; } ts.forEachChild(node, visit); }
  visit(tree);
  if (!found?.body) throw new Error(`函数锚点缺失：${name}`);
  return source.slice(0, found.body.pos) + `{\n${body}\n}` + source.slice(found.body.end);
}
let host = await readFile(`${upstream}/lib/xiaoke-index.js`, 'utf8');
host = replaceOnce(host, "const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')", "const PACKAGE_ROOT = process.env.XIAOKE_ASSET_ROOT\nif (!PACKAGE_ROOT) throw new Error('缺少独立素材目录')");
host = replaceOnce(host, "const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')", "const DSH_HOME = process.env.XIAOKE_DATA_HOME\nif (!DSH_HOME) throw new Error('缺少独立配置目录')");
host = replaceFunction(host, 'fetchBalance', "return globalThis.__xiaokeHostBalance ? globalThis.__xiaokeHostBalance() : { ok: false, code: 'DESKTOP_SOURCE', error: '额度由桌面查询来源提供；此接口不直接访问服务商。' }");
host = replaceFunction(host, 'codexStatsOn', 'return false');
host = replaceFunction(host, 'codexHome', 'return null');
host = replaceOnce(host, 'function getBalance(force = false) {', 'function getBalance(force = false) {\n      force = true // 缓存与来源切换由桌面查询调度器统一管理');
// 即使原版设置里出现其他厂商模板，也不能绕开统一查询与测试隔离边界。
host = "const fetch = async () => { throw new Error('原版外部查询已停用，请使用查询来源设置。') };\n" + host;

let widget = await readFile(`${upstream}/lib/xiaoke-widget.js`, 'utf8');
// 原版会吞掉首次初始化异常；独立桌面入口必须给设置页留下固定的失败状态。
widget = replaceOnce(widget, 'try { dshxkInit() } catch (err) {}', "try { dshxkInit() } catch (err) { window.dispatchEvent(new Event('xiaoke:init-failed')) }");
widget = replaceOnce(widget, 'function dshxkIsChatRoot(r) {', 'function dshxkIsChatRoot(r) {\n  if (window.desktopBridge) return true');
widget = replaceFunction(widget, 'refresh', `return fetch('/desktop/snapshot' + (manual ? '?refresh=1' : ''), { cache: 'no-store' }).then(function(r){return r.json()}).then(applyDesktopSnapshot).catch(function(){})`);
widget = replaceOnce(widget, 'function render() {', 'function render() {\n  if (desktopSnapshot && !desktopIsDeepSeek()) { amountEl.textContent = desktopAmount(); setHint(desktopHint()); return }');
widget = replaceOnce(widget, 'function bubbleAmountText() {', 'function bubbleAmountText() {\n  if (desktopSnapshot && !desktopIsDeepSeek()) return desktopAmount()');
widget = replaceOnce(widget, 'function bubbleTodayText() {', 'function bubbleTodayText() {\n  if (desktopSnapshot && !desktopIsDeepSeek()) return desktopHint()');
widget = replaceOnce(widget, 'function bubbleRowContentOf(mod) {', 'function bubbleRowContentOf(mod) {\n  var desktopRow = desktopBubbleRow(mod); if (desktopRow !== null) return { txt: desktopRow, line: null }');
widget = replaceOnce(widget, 'function bubbleRowsTo(parentEl, mods) {', 'function bubbleRowsTo(parentEl, mods) {\n  mods = desktopDisplayModules(mods)');
widget = replaceOnce(widget, 'function registerIfCountdown(blk) {', 'function registerIfCountdown(blk) {\n    if (blk.mod && blk.mod._desktopReset) { desktopResetRowRegister(blk.tx, blk.mod._desktopReset); return }');
widget = replaceOnce(widget, 'function rightGap() {', 'function rightGap() {\n  if (window.desktopBridge) return 0');
// viewport 保持原版的浏览器 CSS 坐标，客户区消息只触发重新测量。
widget = replaceOnce(widget, 'function onDocContextMenu(e) {\n  try {\n    if (!menuBtnHide) return', 'function onDocContextMenu(e) {\n  try {\n    if (!menuBtnHide && !window.desktopBridge) return');
widget = replaceFunction(widget, 'openApiModelPanel', 'window.desktopBridge.openSettings()');
widget = replaceOnce(widget, 'function setCodexStatsOn(v) {', 'function setCodexStatsOn(v) {\n  v = false');
widget = replaceOnce(widget, 'function codexStatsCheckbox() {', 'function codexStatsCheckbox() {\n  var unavailable = document.createElement("span"); unavailable.textContent = "本机会话统计不可用"; return unavailable;');
// 原版保留在 vendor；下列增量代码仅加入桌面入口、数据文本与鼠标穿透桥接。
const bridge = await readFile('src/renderer/widget-bridge.js', 'utf8');
widget = replaceOnce(widget, "var REFRESH_MS = 60000", bridge + '\nvar REFRESH_MS = 60000');
widget = replaceOnce(widget, 'setInterval(function () { pollLastTurn(); pollWaitState() }, 1000)', 'setInterval(function () { pollLastTurn(); pollWaitState() }, 1000)\n// 原版 DOM 已全部挂载，桌面桥接不等待后台页面的定时器。\ndesktopInitializeBridge()');
await mkdir('dist/vendor/lib', { recursive: true });
await writeFile('dist/vendor/lib/xiaoke-index.js', host);
await writeFile('dist/vendor/lib/xiaoke-widget.js', widget);
await cp(`${upstream}/lib/accounting.mjs`, 'dist/vendor/lib/accounting.mjs');
await cp('src/renderer', 'dist/renderer', { recursive: true, filter: file => !file.endsWith('.ts') });
await cp(`${upstream}/asset-manifest.json`, 'dist/vendor/asset-manifest.json');
await cp(`${upstream}/LICENSE`, 'dist/vendor/LICENSE');
await cp(`${upstream}/PROVENANCE.md`, 'dist/vendor/PROVENANCE.md');
await cp(`${upstream}/upstream/PROVENANCE.upstream.md`, 'dist/vendor/PROVENANCE.upstream.md');
console.log(`原版 ${manifest.commit.slice(0, 12)} 的桌面适配构建完成`);
