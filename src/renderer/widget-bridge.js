// 本文件在构建时插入原版初始化函数中，复用原版闭包内的命中测试、菜单及泡泡系统。
var desktopSnapshot = null;
var desktopResetRows = [];
var desktopResetTimer = null;
var desktopDataRows = [];
var desktopClientViewport = null;
var desktopOverlayVisible = false;
var desktopPlacementRevision = 0;
var desktopPlacementFrame = null;
var desktopCollapsedSince = 0;
var desktopCapturedPointer = null;
var desktopKeyboardWanted = false;
var desktopLastPointer = { x:-1, y:-1 };
var desktopInteractionKey = '';
var desktopUiSelector = '.dshxkv-pop,.dshxkv-menu,.dshxkv-menu-btn,.dshxkv-rolelist,.dshxkv-audiolist,.dshxkv-cropmask,.dshxkv-confirmmask,.dshxkv-audiomask,.dshxkv-snapmask,.dshxkv-bubmask,.dshxkv-qedit,.dshxkv-usagepanel,.dshxkv-usage-mask,.dshxkv-resmask,.dshxkv-custmenu';
function desktopKeyboardField(element) {
  if (!element || !element.closest) return null;
  var field = element.closest('input,textarea,select,[contenteditable="true"]');
  if (!field || field.disabled || field.readOnly) return null;
  if (field.tagName === 'INPUT' && /^(checkbox|radio|range|button|submit|reset|file|hidden)$/i.test(field.type)) return null;
  var rect = field.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? field : null;
}
function desktopReleasePointer() {
  var id = desktopCapturedPointer;
  desktopCapturedPointer = null;
  if (id !== null) { try { if (root.hasPointerCapture(id)) root.releasePointerCapture(id); } catch(err) {} }
}
function desktopUpdateInteraction(force) {
  if (!(drag && drag.active)) desktopReleasePointer();
  var elements = document.elementsFromPoint(desktopLastPointer.x, desktopLastPointer.y);
  var hit = desktopOverlayVisible && (!!(drag && drag.active) || isXiaokeHit({clientX:desktopLastPointer.x,clientY:desktopLastPointer.y}) || elements.some(function(el){return !!el.closest(desktopUiSelector);}));
  // 菜单、泡泡和拖动都不抢键盘焦点；只有用户进入可编辑控件后才允许激活。
  var keyboard = desktopOverlayVisible && desktopKeyboardWanted && !!desktopKeyboardField(document.activeElement);
  var key = [hit,keyboard,!!menuOpen].join(':');
  if (force || key !== desktopInteractionKey) {
    desktopInteractionKey = key;
    window.desktopBridge.setHit(hit, keyboard, !!menuOpen);
  }
}
function desktopAcknowledgePlacement() {
  if (desktopPlacementRevision) window.desktopBridge.placementApplied(desktopPlacementRevision);
}
function desktopPositionMenu() {
  var vp = viewport();
  if (vp.w <= 0 || vp.h <= 0) return;
  var margin = Math.min(8, vp.w / 4, vp.h / 4);
  var availableWidth = Math.max(1, vp.w - margin * 2);
  var availableHeight = Math.max(1, vp.h - margin * 2);
  // 独立透明窗口会裁掉客户区之外的菜单；限宽限高后再测量，短窗口改为菜单内滚动。
  menuBox.style.minWidth = Math.min(196, availableWidth) + 'px';
  menuBox.style.maxWidth = Math.min(340, availableWidth) + 'px';
  menuBox.style.maxHeight = availableHeight + 'px';
  menuBox.style.overflowY = 'auto';
  menuBox.style.overflowX = 'hidden';
  var rootRect = root.getBoundingClientRect();
  var buttonRect = menuBtn.getBoundingClientRect();
  var width = menuBox.offsetWidth;
  var height = menuBox.offsetHeight;
  var onLeft = rootRect.left + rootRect.width / 2 < vp.w / 2;
  var left = onLeft ? buttonRect.left : buttonRect.right - width;
  left = Math.max(margin, Math.min(left, vp.w - width - margin));
  var aboveBottom = rootRect.bottom - rootRect.height * 0.5945 - 6;
  var aboveTop = aboveBottom - height;
  var belowTop = rootRect.bottom + 6;
  menuBox.style.left = left + 'px';
  menuBox.style.right = 'auto';
  if (aboveTop >= margin) {
    menuBox.style.top = 'auto';
    menuBox.style.bottom = (vp.h - aboveBottom) + 'px';
    menuBox.style.maxHeight = (aboveBottom - margin) + 'px';
    menuBox.style.transformOrigin = 'bottom ' + (onLeft ? 'left' : 'right');
  } else {
    var top = belowTop + height <= vp.h - margin ? belowTop : Math.max(margin, Math.min(aboveTop, vp.h - height - margin));
    menuBox.style.top = top + 'px';
    menuBox.style.bottom = 'auto';
    // 展开用量等子界面后内容可能增长，增长也只占当前可见的剩余空间。
    menuBox.style.maxHeight = Math.max(1, vp.h - top - margin) + 'px';
    menuBox.style.transformOrigin = 'top ' + (onLeft ? 'left' : 'right');
  }
}
function desktopSyncPlacement(size, force) {
  // 主进程尺寸只用来提示重新测量；原版布局必须使用浏览器当前的 CSS 视口。
  // 把旧的 DIP 尺寸长期当作 viewport 会在 DPI/合成帧切换后再次算出错误锚点。
  var vp = viewport();
  if (vp.w <= 0 || vp.h <= 0) return false;
  var viewportChanged = !desktopClientViewport || desktopClientViewport.w !== vp.w || desktopClientViewport.h !== vp.h;
  var hasHint = size && Number.isFinite(size.w) && Number.isFinite(size.h);
  var hintW = hasHint ? size.w : desktopClientViewport && desktopClientViewport.hintW;
  var hintH = hasHint ? size.h : desktopClientViewport && desktopClientViewport.hintH;
  var changed = viewportChanged || (hasHint && (!desktopClientViewport || desktopClientViewport.hintW !== hintW || desktopClientViewport.hintH !== hintH));
  desktopClientViewport = { w:vp.w, h:vp.h, hintW:hintW, hintH:hintH };
  // 保留原版拖动过程；松开后再按原版锚点恢复，避免抢走拖动位置。
  if (drag && drag.active) return false;
  var rect = root.getBoundingClientRect();
  var clipped = rect.left < -1 || rect.top < -1 || rect.right > vp.w + 1 || rect.bottom > vp.h + 1;
  // 翻转会短暂经过 scaleX(0)，只恢复持续停在零宽状态的帧，不打断正常动画。
  var collapsed = (rect.width <= 1 || rect.height <= 1) && root.offsetWidth > 1 && root.offsetHeight > 1;
  if (collapsed) { if (!desktopCollapsedSince) desktopCollapsedSince = Date.now(); }
  else desktopCollapsedSince = 0;
  var stuck = desktopCollapsedSince && Date.now() - desktopCollapsedSince > 500;
  if (!force && !changed && !clipped && !stuck) return false;
  // 重用原版锚点、吸附和翻转逻辑。越界恢复要立即生效，不能继续插值旧窗口坐标。
  var previousTransition = root.style.transition;
  root.style.transition = 'none';
  if (!(viewportChanged && state.h === null && state.v === null && applyAnchorPos())) settle();
  root.getBoundingClientRect();
  root.style.transition = previousTransition;
  if (menuOpen) positionMenu();
  desktopCollapsedSince = 0;
  return true;
}
function desktopReceivePlacement(placement) {
  if (!placement || typeof placement.visible !== 'boolean' || !Number.isFinite(placement.revision)) return;
  // invoke 的初始回执可能晚于宿主移动消息到达，旧回执不能覆盖新位置或可见状态。
  if (placement.revision < desktopPlacementRevision) return;
  desktopOverlayVisible = placement.visible;
  desktopPlacementRevision = placement.revision;
  if (placement.cancelDrag && drag && drag.active) endDrag(null, false, true);
  if (!desktopOverlayVisible) {
    desktopKeyboardWanted = false;
    desktopReleasePointer();
    desktopUpdateInteraction(true);
    if (desktopPlacementFrame !== null) cancelAnimationFrame(desktopPlacementFrame);
    desktopPlacementFrame = null;
    dshxkvAudioSuspendNow();
    return;
  }
  desktopSyncPlacement(placement.viewport, placement.recover);
  desktopUpdateInteraction(true);
  if (desktopPlacementFrame !== null) cancelAnimationFrame(desktopPlacementFrame);
  // 第一帧提交新视口后再测一帧；关闭菜单后的重绘必须在位置真正应用之后。
  desktopPlacementFrame = requestAnimationFrame(function () {
    desktopPlacementFrame = requestAnimationFrame(function () {
      desktopPlacementFrame = null;
      desktopSyncPlacement(placement.viewport, placement.recover);
      desktopUpdateInteraction(true);
      desktopAcknowledgePlacement();
    });
  });
}
function desktopResetRowRegister(element, windowName) {
  desktopResetRows.push({ element:element, windowName:windowName });
  if (desktopResetTimer) return;
  desktopResetTimer = setInterval(function(){
    desktopResetRows = desktopResetRows.filter(function(row){return row.element.isConnected;});
    if (!desktopResetRows.length) { clearInterval(desktopResetTimer); desktopResetTimer=null; return; }
    if (document.visibilityState === 'hidden' || !desktopSnapshot || !desktopSnapshot.data || desktopSnapshot.data.kind !== 'subscription') return;
    desktopResetRows.forEach(function(row){ row.element.textContent = (row.windowName==='fiveHour'?'五小时 ':'周额度 ') + desktopReset(desktopSnapshot.data[row.windowName]); });
  },1000);
}
function desktopSourceTitle(full) {
  if (!desktopSnapshot) return '';
  var name = full ? desktopSnapshot.sourceName : desktopSnapshot.sourceName.replace(/（模拟数据）$/, '');
  return name + (desktopSnapshot.data && desktopSnapshot.data.kind === 'subscription' ? ' 用量' : ' 额度');
}
function desktopFitSourceLabel(element) {
  if (!element || !element.style) return;
  // 来源允许长名称；额度标题固定一行，并通过原生提示保留完整名称。
  element.style.display = 'inline-block';
  element.style.maxWidth = 'calc(var(--dshxk-u) * 560)';
  element.style.whiteSpace = 'nowrap';
  element.style.overflow = 'hidden';
  element.style.textOverflow = 'ellipsis';
  element.title = desktopSourceTitle(true);
  element._desktopSourceLabel = true;
}
function desktopClearSourceLabel(element) {
  if (!element || !element._desktopSourceLabel) return;
  // 原版三行场景会复用 labelEl 显示随机语句；只撤销我们添加的标题限制。
  ['display', 'maxWidth', 'whiteSpace', 'overflow', 'textOverflow'].forEach(function(key){element.style[key] = '';});
  element.title = '';
  element._desktopSourceLabel = false;
}
function desktopDataRowRegister(element, mod, container) {
  var original = mod && (mod._desktopMod || mod);
  if (!element || desktopBubbleRow(original) === null) return;
  if (mod._desktopLabel) desktopFitSourceLabel(container || element);
  desktopDataRows = desktopDataRows.filter(function(row){return row.element.isConnected && row.element !== element;});
  desktopDataRows.push({ element:element, mod:original, label:mod._desktopLabel, container:container || element });
}
function desktopUpdateDataRows() {
  // 默认泡泡使用模块节点，旧 amountEl/hintEl 已隐藏。只更新额度文字，保留台词、样式与停留时间。
  desktopDataRows = desktopDataRows.filter(function(row){return row.element.isConnected;});
  desktopDataRows.forEach(function(row){
    var text = desktopBubbleRow(row.mod);
    if (text !== null) row.element.textContent = text;
    if (row.label) desktopFitSourceLabel(row.container);
  });
}
function desktopIsDeepSeek() { return desktopSnapshot && desktopSnapshot.provider === 'deepseek'; }
function desktopReset(row) {
  if (!row || !row.resetsAt) return '';
  var left = Math.max(0, Date.parse(row.resetsAt) - Date.now());
  if (!left) return '等待刷新';
  var mins = Math.ceil(left / 60000);
  return mins >= 1440 ? Math.floor(mins / 1440) + '天后重置' : mins >= 60 ? Math.floor(mins / 60) + '小时' + (mins % 60) + '分后重置' : mins + '分后重置';
}
function desktopWindow(row, label) { return label + '已用 ' + (row ? row.usedPercent.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + '%' : '—') + (row && row.resetsAt ? ' · ' + desktopReset(row) : ''); }
function desktopAmount() {
  var d = desktopSnapshot && desktopSnapshot.data;
  if (!d) return '—';
  if (d.kind === 'subscription') return desktopWindow(d.fiveHour, '五小时');
  if (d.unlimited) return '无限额度（令牌）';
  if (desktopIsDeepSeek()) return d.remaining === null ? '—' : fmt(d.remaining, d.unit);
  return d.remaining === null ? '—' : d.remaining.toLocaleString('zh-CN', { maximumFractionDigits: d.unit === '额度' ? 0 : 6 }) + ' ' + d.unit;
}
function desktopStatusText(text) {
  var s = desktopSnapshot;
  if (!s) return text;
  if (s.status === 'stale') return '旧数据 · ' + text + (s.message ? ' · ' + s.message : ' · 查询失败');
  if (s.status === 'loading') return '正在查询 · ' + text;
  return text;
}
function desktopHint() {
  var s = desktopSnapshot;
  if (!s) return '等待查询';
  if (!s.data) return s.message || '正在查询…';
  if (s.data.kind === 'subscription') return desktopStatusText(desktopWindow(s.data.week, '本周'));
  if (desktopIsDeepSeek()) return desktopStatusText((state.usageLabel || '今日已用') + ' ' + (state.todayUsage === null || state.todayUsage === undefined ? '—' : fmt(state.todayUsage, state.todayUsageCurrency || s.data.unit)));
  return desktopStatusText(s.data.used === null ? '当前账户余额' : '累计已用 ' + s.data.used.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) + ' ' + s.data.unit);
}
function desktopBubbleRow(mod) {
  if (!desktopSnapshot || !mod) return null;
  if (mod.modelId && mod.modelId !== 'deepseek') return /^(balance|today|quota|plan)$/.test(mod.type) ? '请到查询来源配置' : null;
  if (mod.type === 'balance') return desktopIsDeepSeek() ? bubbleContentText(mod, desktopAmount()) : desktopAmount();
  if (mod.type === 'today') {
    if (desktopIsDeepSeek() && desktopSnapshot.data) return desktopStatusText(bubbleContentText(mod, (state.usageLabel || '今日已用') + ' ' + (state.todayUsage === null || state.todayUsage === undefined ? '—' : fmt(state.todayUsage, state.todayUsageCurrency || desktopSnapshot.data.unit))));
    return desktopHint();
  }
  if (!desktopIsDeepSeek() && (mod.type === 'peak' || mod.type === 'nextpeak')) {
    var data = desktopSnapshot.data;
    return data && data.kind === 'subscription' ? (mod.peakStyle === 'count' ? '周额度 ' + desktopReset(data.week) : '五小时 ' + desktopReset(data.fiveHour)) : (desktopSnapshot.status === 'stale' ? '旧数据' : data && data.scope === 'token' ? '令牌额度' : '账户余额');
  }
  if (mod.type === 'session') return '当前对话不可用';
  if (mod.type === 'text' && /^(DeepSeek|小克).*余额$/.test(mod.text || '')) return desktopSourceTitle(false);
  return null;
}
function desktopDisplayModules(mods) {
  if (!desktopSnapshot || !Array.isArray(mods)) return mods;
  var data = desktopSnapshot.data;
  return mods.map(function(mod){
    var label = mod.type === 'text' && /^(DeepSeek|小克).*余额$/.test(mod.text || '');
    var unavailable = mod.modelId && mod.modelId !== 'deepseek';
    if (desktopIsDeepSeek() && !label && !unavailable) return mod;
    var text = desktopBubbleRow(mod);
    if (text === null) return mod;
    var size = mod.size;
    var row = mod.row;
    if (unavailable) size = 2;
    else if (mod.type === 'balance') size = Math.min(size || 8, 8);
    else if (mod.type === 'today') size = Math.min(size || 4, 8);
    else if (mod.type === 'peak' || mod.type === 'nextpeak') {
      size = 2; row = mod.peakStyle === 'count' ? 5 : 4;
    }
    // 只替换金额模板；文字颜色与配套底色必须成对保留，否则原版白字额度卡会变成白底白字。
    var adapted = Object.assign({}, mod, { type:'text', text:text, tpl:'', size:size, row:row, peakStyle:'', _desktopMod:mod, _desktopLabel:label, _desktopReset:data && data.kind === 'subscription' && (mod.type==='peak'||mod.type==='nextpeak') ? (mod.peakStyle==='count'?'week':'fiveHour') : null });
    if (mod.type === 'peak' || mod.type === 'nextpeak') {
      adapted.color = mod.color || mod.offColor || mod.peakColor || '';
      adapted.bg = mod.bg || mod.offBg || '';
      adapted.bgRgb = mod.bgRgb || mod.offBgRgb || '';
      adapted.rgb = mod.rgb || mod.offRgb || '';
    }
    return adapted;
  });
}
function applyDesktopSnapshot(snapshot) {
  var sourceChanged = desktopSnapshot && desktopSnapshot.sourceId !== snapshot.sourceId;
  var changed = desktopSnapshot && JSON.stringify(desktopSnapshot.data) !== JSON.stringify(snapshot.data);
  if (sourceChanged) { hideBubble(); desktopDataRows = []; }
  desktopSnapshot = snapshot;
  // 订阅用量不进入 state.balance、animateAmount 或原版金额提醒逻辑。
  state.balance = snapshot.data && snapshot.data.kind === 'balance' ? snapshot.data.remaining : null;
  state.currency = snapshot.data && snapshot.data.kind === 'balance' ? snapshot.data.unit : null;
  // 加载/失败保留同一 DeepSeek 来源的本地观测日统计；换来源时清空，避免串账户。
  if (sourceChanged || !desktopIsDeepSeek()) {
    state.todayUsage = null; state.todayUsageCurrency = null; state.usageLabel = null;
    state.isPeak = null; state.peakNextChangeAt = null; state.peakHolidays = null;
  }
  shown = state.balance;
  state.status = snapshot.status === 'error' ? 'error' : 'ok';
  state.message = snapshot.message || '';
  render();
  desktopUpdateDataRows();
  if (desktopIsDeepSeek() && snapshot.status === 'ready') {
    fetch('/dsh-xiaoke/balance.json?refresh=1').then(function(r){return r.json()}).then(function(balance){
      if (!balance.ok || desktopSnapshot !== snapshot) return;
      state.todayUsage = balance.todayUsage; state.todayUsageCurrency = balance.todayUsageCurrency; state.usageLabel = balance.usageLabel;
      state.isPeak = balance.isPeak; state.peakNextChangeAt = balance.peakNextChangeAt; state.peakHolidays = balance.peakHolidays;
      checkUsageAlerts(state.balance, state.todayUsage); render(); desktopUpdateDataRows();
    }).catch(function(){});
  }
  if (changed && snapshot.status === 'ready' && desktopOverlayVisible && document.visibilityState === 'visible') showBubble();
}
function desktopInitializeBridge() {
  var sourceRow = menuRow();
  var sourceButton = document.createElement('button');
  sourceButton.className = 'dshxkv-snapbtn'; sourceButton.textContent = '查询来源'; sourceButton.id = 'desktop-source-button';
  sourceButton.addEventListener('click', function(e){ e.stopPropagation(); window.desktopBridge.openSettings(); });
  sourceRow.appendChild(sourceButton); menuBox.insertBefore(sourceRow, menuBox.firstChild);
  var notice = document.createElement('div'); notice.className = 'dshxkv-bubhint'; notice.style.padding = '6px 8px'; notice.textContent = '每轮消耗、等待提示、任务结束事件和聊天布局在桌面贴附模式不可用；音效仍可试听。'; menuBox.appendChild(notice);
  [turnCostToggle, turnCostCloseInput, scrollGapToggle, scrollGapInput, turnCostCustomBtn, taskEndToggle].forEach(function(el){ if(el){ el.disabled=true; el.title='无聊天事件或页面访问权限，此功能不可用'; } });
  window.desktopBridge.onSnapshot(applyDesktopSnapshot);
  window.desktopBridge.onPlacement(desktopReceivePlacement);
  function desktopPointer(point){
    desktopLastPointer = { x:point.x, y:point.y };
    if (desktopSyncPlacement(point.viewport)) desktopAcknowledgePlacement();
    desktopUpdateInteraction(false);
  }
  window.desktopBridge.onPointer(desktopPointer);
  // 命中区域中的真实移动立即处理；穿透区只使用主进程光标 IPC，不转发无按键的模拟移动。
  document.addEventListener('mousemove', function(e){desktopPointer({x:e.clientX,y:e.clientY});});
  document.addEventListener('pointerdown', function(e){
    desktopLastPointer = { x:e.clientX, y:e.clientY };
    // 原版的捕获监听先建立 drag，随后为该指针保留捕获，保证窗口外松手也能收尾。
    if (drag && drag.active) {
      try { root.setPointerCapture(e.pointerId); desktopCapturedPointer = e.pointerId; } catch(err) {}
    }
    desktopKeyboardWanted = !!desktopKeyboardField(e.target);
    desktopUpdateInteraction(true);
  }, true);
  root.addEventListener('lostpointercapture', function(e){
    if (desktopCapturedPointer !== null && e.pointerId !== desktopCapturedPointer) return;
    desktopCapturedPointer = null;
    if (drag && drag.active) endDrag(null, false, true);
    desktopUpdateInteraction(true);
  });
  document.addEventListener('focusin', function(e){ desktopKeyboardWanted = !!desktopKeyboardField(e.target); desktopUpdateInteraction(false); });
  document.addEventListener('focusout', function(){ queueMicrotask(function(){ desktopUpdateInteraction(false); }); });
  window.addEventListener('blur', function(){ desktopKeyboardWanted = false; desktopUpdateInteraction(true); });
  // 菜单开合/编辑控件出现后立即同步，不能等待下一次鼠标移动才变更交互状态。
  var interactionObserver = new MutationObserver(function(){ desktopUpdateInteraction(false); });
  interactionObserver.observe(document.body, { subtree:true, childList:true, attributes:true, attributeFilter:['class','style','disabled','readonly'] });
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && menuOpen) closeMenu(); });
  window.__xiaokeDesktop = { openMenu: toggleMenu, closeMenu: closeMenu, showBubble: showBubble, hideBubble: hideBubble, isHit: isXiaokeHit, snapshot: function(){return desktopSnapshot;}, openBubbleEditor: openBubbleEditor, openResources: openResManager, openSoundSettings: openSoundSettingsPanel };
  // 就绪通知必须有回执，不能把首次显示押在一次 send 上。重试仅走应用内部 IPC。
  var readyPending = false;
  var readyTimer = setInterval(confirmReady, 1000);
  function confirmReady() {
    if (readyPending) return;
    readyPending = true;
    window.desktopBridge.ready().then(function(result) {
      if (!result || !result.placement || !result.snapshot) return;
      clearInterval(readyTimer);
      if (!desktopSnapshot) applyDesktopSnapshot(result.snapshot);
      desktopReceivePlacement(result.placement);
    }).catch(function(){ window.desktopBridge.rendererFailed(); }).finally(function(){ readyPending = false; });
  }
  confirmReady();
}
