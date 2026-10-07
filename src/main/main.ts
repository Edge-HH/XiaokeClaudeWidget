import { app, BrowserWindow, ipcMain, Menu, Tray, dialog, safeStorage, protocol, screen, nativeImage, shell, net } from 'electron';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SettingsStore, validateSource } from './storage.js';
import { Providers, createHttpTransport, createMockTransport } from './providers.js';
import { UsageScheduler } from './scheduler.js';
import { AssetManager, type AssetManifest } from './assets.js';
import { UpstreamHost } from './upstream-host.js';
import { WindowTracker } from './window-tracker.js';
import { canShowPet } from './window-policy.js';
import type { AttachmentState, DesktopState, HostGeometry, SourceConfig, UsageSnapshot } from '../shared/types.js';

const arguments_ = process.argv.slice(1);
const testMode = arguments_.includes('--test');
const demo = !app.isPackaged || arguments_.includes('--demo') || testMode;
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argumentValue = (name: string) => { const i = arguments_.indexOf(name); return i >= 0 ? arguments_[i + 1] : undefined; };
if (demo) app.setPath('userData', argumentValue('--user-data') ?? path.join(app.getPath('appData'), 'XiaokeWidget-demo'));
protocol.registerSchemesAsPrivileged([{ scheme: 'xiaoke', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const primaryInstance = app.requestSingleInstanceLock() || testMode;
if (!primaryInstance) app.quit();

let overlay: BrowserWindow | null = null;
let settings: BrowserWindow | null = null;
let mock: BrowserWindow | null = null;
let tray: Tray | null = null;
let lastHost: HostGeometry | null = null;
let tracker: WindowTracker | null = null;
let pointerTimer: ReturnType<typeof setInterval> | null = null;
let store: SettingsStore;
let scheduler: UsageScheduler;
let assets: AssetManager;
let providers: Providers;
const upstream = new UpstreamHost();
let quitting = false;
let editing = false;
let petMenuOpen = false;
let settingsDialogOpen = false;
let pointerHit = false;
let helperFailed = '';
let attachmentPaused = false;
let foregroundFixture: boolean | null = null;
let nativeOwnForeground = false;
let pointerFixture: Electron.Point | null = null;
let overlayReady = false;
let overlayDocumentLoaded = false;
let rendererFailed = false;
let appliedPlacementRevision = 0;
let trayMenuOpen = false;
let placementRevision = 0;
let appliedHostKey = '';
let recoverRequested = false;

function stopPointerTracking() {
  if (pointerTimer) clearInterval(pointerTimer);
  pointerTimer = null;
}
function allWindows() { return [overlay, settings, mock].filter((window): window is BrowserWindow => !!window && !window.isDestroyed()); }
function sendSnapshot(snapshot: UsageSnapshot) { for (const window of allWindows()) window.webContents.send('desktop:snapshot', snapshot); }
function activeSource() { const prefs = store.getPreferences(); return prefs.sources.find(row => row.id === prefs.activeId)!; }
function applyMouseHit(hit: boolean, force = false) {
  if (!overlay || overlay.isDestroyed() || (!force && hit === pointerHit)) return;
  pointerHit = hit;
  // 已有独立光标 IPC；Windows 转发 WM_MOUSEMOVE 不含按键标志，不能再混入原版拖动事件。
  overlay.setIgnoreMouseEvents(!hit, { forward: false });
}
function attachmentState(): AttachmentState {
  const overlayVisible = !!overlay && !overlay.isDestroyed() && overlay.isVisible();
  const helper = helperFailed ? 'failed' : tracker?.mode ? 'running' : 'starting';
  let message = '宠物窗口已启用；实际绘制和鼠标交互请在宿主中确认。';
  if (helperFailed) message = helperFailed;
  else if (helper === 'starting') message = '窗口辅助组件正在启动。';
  else if (!lastHost) message = demo ? '没有检测到模拟宿主窗口。' : '没有识别到 Claude Desktop 主窗口。请确认桌面客户端窗口已打开。';
  else if (lastHost.minimized) message = '宿主窗口已最小化，宠物暂时隐藏。';
  else if (!lastHost.visible || lastHost.width <= 0 || lastHost.height <= 0) message = '宿主客户区当前不可见，宠物暂时隐藏。';
  else if (rendererFailed) message = '宠物页面初始化失败。请退出小克后重新运行完整新版。';
  else if (!overlayDocumentLoaded) message = '宠物页面正在加载。';
  else if (!overlayReady) message = '宠物页面已加载，但桌面桥接尚未就绪。';
  else if (!lastHost.foreground && !nativeOwnForeground) message = '已识别宿主，但宿主不在前台；点击宿主窗口后显示宠物。';
  else if (!overlayVisible) message = '宿主已识别并在前台，正在恢复宠物窗口。';
  else if (appliedPlacementRevision !== placementRevision) message = '宠物窗口已显示，正在应用客户区位置。';
  else if (nativeOwnForeground && settings?.isFocused()) message = '小克设置在前台，宠物保持贴附；关闭设置后可在宿主中操作。';
  return {
    version: app.getVersion(), helper, hostDetected: !!lastHost,
    hostVisible: lastHost?.visible === true, hostMinimized: lastHost?.minimized === true,
    hostForeground: lastHost?.foreground === true, pageLoaded: overlayDocumentLoaded,
    bridgeReady: overlayReady, overlayVisible, placementApplied: overlayReady && appliedPlacementRevision === placementRevision,
    onTop: !!overlay && !overlay.isDestroyed() && overlay.isAlwaysOnTop(), keyboardEditing: editing, menuOpen: petMenuOpen,
    message,
  };
}
async function state(): Promise<DesktopState> {
  const assetState = await assets.state();
  // 检查素材可能跨过一次查询完成；在返回前读取快照，避免旧 loading 覆盖已送达的结果。
  return { demo, preferences: store.getPreferences(), configured: store.configured(), snapshot: scheduler.snapshot(), assets: assetState, attachment: attachmentState() };
}
function secureWindow(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(({ url }) => { if (!demo && /^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('xiaoke://app/')) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
}
function windowOptions() {
  return { preload: path.join(base, 'main', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true };
}
function sendPlacement(recover = false, cancelDrag = false) {
  if (!overlay || overlay.isDestroyed() || !overlayReady) return;
  const bounds = overlay.getContentBounds();
  const zoom = overlay.webContents.getZoomFactor();
  const placement = {
    revision: ++placementRevision, visible: overlay.isVisible(), recover, cancelDrag,
    viewport: { w: bounds.width / zoom, h: bounds.height / zoom },
  };
  overlay.webContents.send('desktop:placement', placement);
  return placement;
}
function recoverOverlay() {
  if (quitting) return;
  recoverRequested = true;
  // 要求辅助组件重新读取元数据；不能只依赖设置窗口曾经触发的前台变化。
  tracker?.refresh();
  applyHost(lastHost);
}
function openSettings() {
  if (settings && !settings.isDestroyed()) { settings.show(); settings.focus(); return; }
  settings = new BrowserWindow({ title: '小克 · 查询来源与素材', width: 760, height: 800, minWidth: 620, minHeight: 540, backgroundColor: '#faf7f3', autoHideMenuBar: true, webPreferences: windowOptions() });
  settings.setMenu(null); secureWindow(settings);
  void settings.loadURL('xiaoke://app/settings.html');
  settings.on('closed', () => { settings = null; recoverOverlay(); });
  settings.on('focus', () => applyHost(lastHost));
  settings.on('blur', () => setTimeout(() => applyHost(lastHost), 50));
}
function applyHost(host: HostGeometry | null, ownForeground = nativeOwnForeground) {
  if (quitting) return;
  const previousForeground = lastHost?.foreground === true;
  const returnedToHost = nativeOwnForeground && !ownForeground && host?.foreground === true;
  lastHost = host;
  nativeOwnForeground = ownForeground;
  if (!overlay || overlay.isDestroyed()) return;
  if (testMode && attachmentPaused) { overlay.hide(); return; }
  // 生产模式只信任 Win32 前台状态。Electron 的逻辑 focus 在系统拒绝激活时可能仍为真。
  const visible = canShowPet(host, testMode ? foregroundFixture : null, ownForeground);
  let boundsChanged = false;
  if (host && !host.minimized && host.width > 0 && host.height > 0) {
    const bounds = screen.screenToDipRect(null, { x: host.x, y: host.y, width: host.width, height: host.height });
    const key = [host.hwnd, host.dpi, bounds.x, bounds.y, bounds.width, bounds.height].join(':');
    const actual = overlay.getBounds();
    const drifted = Math.abs(actual.x - bounds.x) > 2 || Math.abs(actual.y - bounds.y) > 2 || Math.abs(actual.width - bounds.width) > 2 || Math.abs(actual.height - bounds.height) > 2;
    if (bounds.width > 0 && bounds.height > 0 && (key !== appliedHostKey || drifted)) {
      overlay.setBounds(bounds, false); appliedHostKey = key; boundsChanged = true;
    }
  }
  // 隐藏页面也要先得到宿主尺寸。显示只等待文档加载，不能被一次性 IPC 通知永久拦住。
  if (!overlayDocumentLoaded && !overlayReady) { scheduler?.setVisible(false); return; }
  const wasVisible = overlay.isVisible();
  const topmost = visible && !trayMenuOpen;
  const layerChanged = overlay.isAlwaysOnTop() !== topmost;
  if (visible) {
    // 一次 moveTop 不能保证宿主随后激活时仍在其上；可见期间使用稳定覆盖层级。
    if (layerChanged) overlay.setAlwaysOnTop(topmost);
    if (!wasVisible) overlay.showInactive();
  } else {
    if (wasVisible) overlay.hide();
    if (layerChanged) overlay.setAlwaysOnTop(false);
    applyMouseHit(false);
  }
  const recover = recoverRequested || boundsChanged || (visible && !wasVisible);
  // 菜单显示时不重排透明窗口，避免遮挡原生菜单或干扰其关闭后的合成帧。
  const raiseOverlay = visible && !trayMenuOpen && (recover || layerChanged || (host?.foreground === true && !previousForeground) || returnedToHost);
  if (raiseOverlay) overlay.moveTop();
  if (settings && !settings.isDestroyed()) {
    // 设置在本项目覆盖层之上；切到其他应用时撤销它的顶置。
    const raiseSettings = ownForeground && (settings.isFocused() || settingsDialogOpen);
    const settingsLayerChanged = settings.isAlwaysOnTop() !== raiseSettings;
    if (settingsLayerChanged) settings.setAlwaysOnTop(raiseSettings);
    if (raiseSettings && (raiseOverlay || settingsLayerChanged)) settings.moveTop();
  }
  if (visible && (recover || layerChanged)) applyMouseHit(pointerHit, true);
  if (recover || wasVisible !== visible) sendPlacement(recover, wasVisible && !visible);
  if (visible) recoverRequested = false;
  scheduler?.setVisible(visible || (!!settings?.isFocused() && ownForeground));
}
function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  return allWindows().some(window => window.webContents === event.sender) && event.senderFrame?.url.startsWith('xiaoke://app/');
}
function handle(channel: string, callback: (...args: any[]) => unknown) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) return { ok: false, error: '本地请求来源无效。' };
    try { return { ok: true, value: await callback(...args) }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '操作失败。' }; }
  });
}
function selectSaved() { scheduler.select(activeSource()); void scheduler.refresh(true); sendSnapshot(scheduler.snapshot()); }
function installIpc() {
  ipcMain.handle('desktop:ready', event => {
    if (event.sender !== overlay?.webContents || !trusted(event)) return;
    overlayReady = true;
    rendererFailed = false;
    sendSnapshot(scheduler.snapshot());
    recoverOverlay();
    // invoke 回执附带初始位置和快照，发送方可以确认握手，丢失通知时可安全重试。
    return { snapshot: scheduler.snapshot(), placement: sendPlacement(true) };
  });
  ipcMain.on('desktop:renderer-failed', event => {
    if (event.sender === overlay?.webContents && trusted(event)) rendererFailed = true;
  });
  ipcMain.on('desktop:placement-applied', (event, revision: unknown) => {
    if (event.sender !== overlay?.webContents || !trusted(event) || revision !== placementRevision) return;
    appliedPlacementRevision = revision as number;
    if (overlay && !overlay.isDestroyed() && overlay.isVisible()) {
      applyMouseHit(pointerHit, true);
      overlay.webContents.invalidate();
    }
  });
  handle('desktop:state', state);
  // 只返回本项目的显示状态；不读取凭据、不刷新额度、不返回宿主标题或聊天内容。
  handle('desktop:attachment', attachmentState);
  handle('desktop:save', async (input: SourceConfig, secret: string) => { await store.save(input, secret); await store.activate(input.id); selectSaved(); return state(); });
  handle('desktop:remove', async (id: string) => { await store.remove(id); selectSaved(); return state(); });
  handle('desktop:activate', async (id: string) => { await store.activate(id); selectSaved(); return state(); });
  handle('desktop:organizations', (id: string, secret: string) => providers.organizations(secret || store.secret(id), AbortSignal.timeout(10_000)));
  handle('desktop:test-source', (input: SourceConfig, secret: string) => providers.getSnapshot(validateSource(input), secret || store.secret(input.id), AbortSignal.timeout(10_000)));
  handle('desktop:refresh', () => scheduler.refresh(true));
  handle('desktop:download-assets', async () => {
    if (testMode) throw new Error('测试模式不执行素材联网下载，请使用测试素材缓存。');
    const result = await assets.download(); overlay?.reload(); return result;
  });
  handle('desktop:import-assets', async () => {
    // 原生目录选择框由设置拥有；它取得焦点时也保持父窗口在宠物之上。
    settingsDialogOpen = true; applyHost(lastHost);
    try {
      const result = await dialog.showOpenDialog(settings!, { title: '选择原版插件的 assets 目录', properties: ['openDirectory'] });
      if (result.canceled) return assets.state();
      const imported = await assets.import(result.filePaths[0]); overlay?.reload(); return imported;
    } finally { settingsDialogOpen = false; recoverOverlay(); }
  });
  ipcMain.on('desktop:open-settings', event => { if (trusted(event)) openSettings(); });
  ipcMain.on('desktop:close-settings', event => { if (trusted(event)) settings?.close(); });
  ipcMain.on('desktop:hit', (event, hit: unknown, isEditing: unknown, menuOpen: unknown) => {
    if (event.sender !== overlay?.webContents || !trusted(event)) return;
    const nextHit = hit === true;
    applyMouseHit(nextHit);
    const menuClosed = petMenuOpen && menuOpen !== true;
    petMenuOpen = menuOpen === true;
    if ((isEditing === true) !== editing) {
      editing = isEditing === true; overlay.setFocusable(editing);
      // Electron 的 setFocusable(true) 会取消 skipTaskbar，需要显式恢复。
      overlay.setSkipTaskbar(true); applyMouseHit(pointerHit, true);
      if (editing && overlay.isVisible() && !settings?.isFocused() && !settingsDialogOpen) overlay.focus();
      // 普通菜单不经过此分支。真实输入聚焦不应取消正在进行的鼠标手势。
      if (editing) sendPlacement();
      else setTimeout(recoverOverlay, 0);
    }
    if (menuClosed) setTimeout(recoverOverlay, 0);
  });
}

async function installProtocol() {
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
  protocol.handle('xiaoke', async request => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('无效来源', { status: 403 });
    const origin = (request as Request & { initiatorOrigin?: string }).initiatorOrigin;
    if (origin && origin !== 'xiaoke://app') return new Response('无效来源', { status: 403 });
    if (url.pathname === '/desktop/snapshot') {
      const snapshot = url.searchParams.has('refresh') ? await scheduler.refresh(true) : scheduler.snapshot();
      return Response.json(snapshot);
    }
    if (testMode && !app.isPackaged && url.pathname === '/test/original.html') return new Response('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}textarea{display:none}</style></head><body><div id="root"><textarea></textarea></div><script defer src="/test/original-widget.js"></script></body></html>', { headers: { 'content-type': 'text/html' } });
    if (testMode && !app.isPackaged && url.pathname === '/test/original-widget.js') return new Response(new Uint8Array(await readFile(path.join(app.getAppPath(), 'vendor/upstream/lib/xiaoke-widget.js'))), { headers: { 'content-type': 'text/javascript' } });
    if (url.pathname.startsWith('/dsh-xiaoke/')) return upstream.handle(request);
    const fileName = url.pathname === '/widget.js' ? path.join(base, 'vendor', 'lib', 'xiaoke-widget.js') : path.join(base, 'renderer', url.pathname === '/' ? 'overlay.html' : decodeURIComponent(url.pathname).slice(1));
    const rendererRoot = path.join(base, 'renderer');
    if (url.pathname !== '/widget.js' && (path.relative(rendererRoot, fileName).startsWith('..') || path.isAbsolute(path.relative(rendererRoot, fileName)))) return new Response('无效路径', { status: 403 });
    try {
      const bytes = await readFile(fileName);
      return new Response(new Uint8Array(bytes), { headers: { 'content-type': mime[path.extname(fileName)] ?? 'application/octet-stream', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src 'none'" } });
    } catch { return new Response('文件不存在', { status: 404 }); }
  });
}
async function initialize() {
  const directory = app.getPath('userData');
  await mkdir(directory, { recursive: true });
  store = new SettingsStore(directory, safeStorage); await store.initialize();
  if (demo && !store.configured().includes('claude-default')) {
    await store.save({ id: 'claude-default', kind: 'claude', name: 'Claude（模拟数据）', organizationId: 'demo-account' }, 'demo-session-only');
  }
  const manifest = JSON.parse(await readFile(path.join(base, 'vendor', 'asset-manifest.json'), 'utf8')) as AssetManifest;
  assets = new AssetManager(path.join(directory, 'original'), manifest);
  const fixture = argumentValue('--fixture-assets');
  if (testMode && fixture) await assets.import(path.resolve(fixture));
  providers = new Providers(demo ? createMockTransport() : createHttpTransport((url, options) => net.fetch(url, options)));
  scheduler = new UsageScheduler(providers, activeSource(), id => store.secret(id), sendSnapshot);
  // 原版 DeepSeek 观测账本继续使用自己的精确金额逻辑。订阅百分比永远不会进入它。
  (globalThis as typeof globalThis & { __xiaokeHostBalance?: () => unknown }).__xiaokeHostBalance = () => {
    const snapshot = scheduler.snapshot();
    const data = snapshot.data;
    if (activeSource().kind !== 'deepseek' || data?.kind !== 'balance' || data.remaining === null) return { ok: false, code: 'DESKTOP_SOURCE', error: '当前来源没有 DeepSeek 观测记账。' };
    return { ok: true, totalBalance: data.remaining, currency: data.unit, updatedAt: snapshot.observedAt, accountTag: createHash('sha256').update(activeSource().id + ':' + store.secret(activeSource().id)).digest('hex').slice(0, 24), stale: snapshot.status === 'stale' };
  };
  await upstream.initialize(path.join(directory, 'pet-settings'), assets.root, path.join(base, 'vendor', 'lib', 'xiaoke-index.js'));
  await installProtocol(); installIpc();
  // 宠物常驻非激活透明窗口：不能用页面后台节流来控制其初始化和合成帧。
  // 隐藏时的额度轮询仍由主进程 scheduler 暂停。
  overlay = new BrowserWindow({ title: '小克额度宠物', show: false, frame: false, transparent: true, thickFrame: false, resizable: false, skipTaskbar: true, focusable: false, hasShadow: false, width: 1000, height: 700, webPreferences: { ...windowOptions(), backgroundThrottling: false } });
  overlay.setMenu(null); applyMouseHit(false, true); secureWindow(overlay);
  overlay.webContents.on('did-start-loading', () => {
    overlayReady = false; overlayDocumentLoaded = false; rendererFailed = false; appliedPlacementRevision = 0;
    if (overlay && !overlay.isDestroyed()) {
      overlay.hide();
      editing = false; petMenuOpen = false;
      overlay.setFocusable(false); overlay.setSkipTaskbar(true); applyMouseHit(false, true);
    }
    scheduler.setVisible(false);
  });
  overlay.webContents.on('did-finish-load', () => {
    overlayDocumentLoaded = true;
    recoverOverlay();
  });
  overlay.webContents.on('preload-error', () => { rendererFailed = true; });
  overlay.webContents.on('render-process-gone', () => {
    overlayReady = false; overlayDocumentLoaded = false; rendererFailed = true;
    if (overlay && !overlay.isDestroyed()) overlay.hide();
    scheduler.setVisible(false);
  });
  overlay.on('show', () => sendPlacement(true));
  await overlay.loadURL('xiaoke://app/overlay.html');
  overlay.on('close', event => { if (!quitting) { event.preventDefault(); overlay?.hide(); } });
  overlay.on('closed', () => {
    // 窗口销毁后停止周期回调并释放引用，避免退出或测试清理时反复访问失效对象。
    stopPointerTracking();
    overlay = null; overlayReady = false; overlayDocumentLoaded = false;
  });
  // 图标由代码绘制，不把受限原版角色图片放入托盘或安装包。
  const icon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFUlEQVR42mO8mZ76n4ECwESJ5lEDBgAAdrEDsV4ceCUAAAAASUVORK5CYII=', 'base64');
  tray = new Tray(nativeImage.createFromBuffer(icon)); tray.setToolTip(demo ? '小克 · 模拟模式' : '小克额度宠物');
  const trayMenu = Menu.buildFromTemplate([{ label: '查询来源与素材', click: openSettings }, { label: '刷新额度', click: () => void scheduler.refresh(true) }, { label: '退出小克', click: () => app.quit() }]);
  trayMenu.on('menu-will-show', () => { trayMenuOpen = true; applyHost(lastHost); sendPlacement(false, true); });
  trayMenu.on('menu-will-close', () => {
    trayMenuOpen = false;
    // 让原生菜单先结束消息循环，再同步位置、重绘透明窗口。
    setTimeout(recoverOverlay, 0);
  });
  tray.setContextMenu(trayMenu);
  tray.on('double-click', openSettings);
  if (demo) {
    mock = new BrowserWindow({ title: '小克离线验收 · 模拟宿主', width: 1080, height: 760, minWidth: 420, minHeight: 320, backgroundColor: '#f5f2ed', autoHideMenuBar: true, webPreferences: windowOptions() });
    mock.setMenu(null); secureWindow(mock); await mock.loadURL('xiaoke://app/mock.html');
    mock.on('closed', () => { mock = null; applyHost(null); });
  }
  const helper = app.isPackaged ? path.join(process.resourcesPath, 'native', 'WindowBridge.exe') : path.join(base, 'native', 'WindowBridge.exe');
  tracker = new WindowTracker(applyHost, message => { helperFailed = message; applyHost(null); });
  const mockHandle = mock?.getNativeWindowHandle().readBigUInt64LE().toString();
  const started = tracker.start(helper, process.pid, mockHandle);
  if (overlayReady) recoverOverlay();
  if (!started && demo && mock) {
    const update = () => {
      if (!mock || mock.isDestroyed()) return;
      const physical = screen.dipToScreenRect(mock, mock.getContentBounds());
      applyHost({ hwnd: mockHandle!, processId: process.pid, ...physical, dpi: 96 * screen.getDisplayMatching(mock.getBounds()).scaleFactor, foreground: mock.isFocused() || !!overlay?.isFocused() || !!settings?.isFocused(), minimized: mock.isMinimized(), visible: mock.isVisible() });
    };
    mock.on('move', update); mock.on('resize', update); mock.on('focus', update); mock.on('blur', update);
    mock.on('minimize', update); mock.on('restore', update); mock.on('show', update); mock.on('hide', update);
    update();
  }
  pointerTimer = setInterval(() => {
    // Electron 已销毁的窗口只能先调用 isDestroyed，不能先读取可见性。
    if (!overlay || overlay.isDestroyed() || !overlayReady || !overlay.isVisible()) return;
    const point = screen.getCursorScreenPoint(); const bounds = overlay.getContentBounds();
    const zoom = overlay.webContents.getZoomFactor();
    const pointer = testMode && pointerFixture ? pointerFixture : { x: (point.x - bounds.x) / zoom, y: (point.y - bounds.y) / zoom };
    // 带上本窗口客户区尺寸，恢复显示时不依赖可能在托盘切换期间丢失的 resize 通知。
    overlay.webContents.send('desktop:pointer', { ...pointer, viewport: { w: bounds.width / zoom, h: bounds.height / zoom } });
  }, 32);
  pointerTimer.unref();
  if (!(await assets.state()).ready || helperFailed || arguments_.includes('--settings')) openSettings();
  if (testMode) {
    (globalThis as typeof globalThis & { __xiaokeTest?: unknown }).__xiaokeTest = {
      host: () => lastHost, helperMode: () => tracker?.mode, queryMode: 'mock',
      foreground: (value: boolean | null) => { foregroundFixture=value; applyHost(lastHost); },
      pointer: (value: Electron.Point | null) => { pointerFixture=value; },
      pauseAttachment: (paused: boolean) => { attachmentPaused=paused; applyHost(lastHost); },
      trayCycle: () => {
        // 只操作本项目托盘菜单，自动关闭以免无人值守验收阻塞。
        setTimeout(() => tray?.closeContextMenu(), 120);
        tray?.popUpContextMenu();
      },
      input: (action: 'focus' | 'move' | 'click' | 'right-click', point: Electron.Point) => tracker!.testInput(action, screen.dipToScreenPoint(point)),
      mouseStyle: () => tracker!.testInput('style', {x:0,y:0}, overlay!.getNativeWindowHandle().readBigUInt64LE().toString()),
    };
    // 仅测试入口暴露模拟宿主操作，生产包不接受控制其他程序的测试指令。
    ipcMain.handle('test:host', (_event, action: string, value: unknown) => {
      if (!mock) return;
      if (action === 'bounds') mock.setBounds(value as Electron.Rectangle);
      if (action === 'minimize') mock.minimize();
      if (action === 'restore') { mock.restore(); mock.focus(); }
      if (action === 'focus') mock.focus();
      if (action === 'hide') mock.hide();
      if (action === 'close') mock.close();
    });
  }
}
app.on('second-instance', openSettings);
app.on('window-all-closed', () => { /* 宿主退出后保留托盘；退出必须由托盘命令触发。 */ });
app.on('before-quit', () => { quitting = true; stopPointerTracking(); scheduler?.dispose(); tracker?.dispose(); upstream.dispose(); tray?.destroy(); });
if (primaryInstance) app.whenReady().then(initialize).catch((error: unknown) => {
  if (testMode) {
    const frames = error instanceof Error ? error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).join('\n') : '';
    console.error('小克测试初始化失败：' + (error instanceof Error ? error.name : '未知错误') + '\n' + frames);
  } else dialog.showErrorBox('小克启动失败', '配置或程序组件无法读取。请检查用户数据目录和完整安装包；程序未启动任何 Claude 工具。');
  app.quit();
});
