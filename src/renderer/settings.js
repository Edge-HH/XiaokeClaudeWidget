const bridge = window.desktopBridge;
const el = id => document.getElementById(id);
let currentState;
let editingId;
let busy = false;
let attachmentPending = false;
function message(text, error = false) { el('status').textContent = text; el('status').dataset.error = String(error); }
async function invoke(promise) { const result = await promise; if (!result.ok) throw new Error(result.error); return result.value; }
async function operation(callback) {
  if (busy) return;
  busy = true; document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await callback(); } catch (error) { message(error.message || '操作失败，请重试。', true); }
  finally { busy = false; document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
function renderAssets(assets) { el('asset-state').textContent = assets.ready ? '原版素材已就绪。' : '尚未取得完整原版素材：下载或导入后即可显示宠物。'; }
function renderAttachment(status) {
  el('attachment-state').textContent = status.message;
  const helper = { starting: '辅助组件启动中', running: '辅助组件运行中', failed: '辅助组件失败' };
  el('attachment-details').textContent = [
    '运行版本 ' + status.version, helper[status.helper], status.hostDetected ? '宿主已识别' : '宿主未识别',
    status.pageLoaded ? '页面已加载' : '页面未加载', status.bridgeReady ? '桥接就绪' : '桥接未就绪',
    status.overlayVisible ? '窗口处于显示状态' : '宠物窗口隐藏', status.placementApplied ? '位置回执已确认' : '位置未确认',
    status.onTop ? '覆盖层已置顶' : '覆盖层未置顶', status.keyboardEditing ? '键盘编辑已启用' : '普通点击不激活窗口',
  ].join(' · ');
}
async function refreshAttachment() {
  if (attachmentPending) return;
  attachmentPending = true;
  try { renderAttachment(await invoke(bridge.attachment())); }
  catch { el('attachment-state').textContent = '暂时无法读取显示状态，请重新打开小克设置。'; }
  finally { attachmentPending = false; }
}
function formatData(data) {
  if (!data) return '尚未取得额度。';
  if (data.kind === 'subscription') return [['五小时', data.fiveHour], ['本周', data.week]].map(([name, row]) => name + '已用：' + (row ? row.usedPercent + '%' : '—') + (row?.resetsAt ? '\n重置：' + new Date(row.resetsAt).toLocaleString('zh-CN') : '')).join('\n');
  const number = value => value === null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) + ' ' + data.unit;
  return (data.scope === 'token' ? '令牌' : '账户') + '剩余：' + (data.unlimited ? '无限额度' : number(data.remaining)) + (data.used !== null ? '\n累计已用：' + number(data.used) : '');
}
function renderSnapshot(snapshot) {
  el('usage-output').textContent = formatData(snapshot.data) + (snapshot.message ? '\n' + snapshot.message : '');
  el('observed-at').textContent = (snapshot.status === 'stale' ? '旧数据 · ' : '') + snapshot.sourceName + (snapshot.observedAt ? ' · 更新于 ' + new Date(snapshot.observedAt).toLocaleString('zh-CN') : '') + (snapshot.status === 'loading' ? ' · 正在查询…' : '');
}
function typeChanged() {
  const kind = el('source-kind').value;
  const newapi = kind.startsWith('newapi');
  el('base-row').hidden = !newapi; el('conversion-fields').hidden = !newapi;
  el('claude-fields').hidden = kind !== 'claude'; el('user-row').hidden = kind !== 'newapi-account';
  el('secret-label').textContent = kind === 'claude' ? 'sessionKey 的值' : kind === 'newapi-account' ? '账户访问令牌' : 'API Key';
  el('scope-note').textContent = kind === 'newapi-token' ? '这里只显示单个令牌额度，不代表整个账户余额；无限额度也不代表账户余额无限。' : kind === 'deepseek' ? '余额按接口返回的币种显示；不会发送模型请求。' : '';
  el('base-url').required = newapi; el('user-id').required = kind === 'newapi-account';
}
function loadForm(config) {
  editingId = config.id;
  el('source-name').value = config.name; el('source-kind').value = config.kind;
  el('base-url').value = config.baseUrl || ''; el('user-id').value = config.userId || '';
  el('source-secret').value = ''; el('quota-unit').value = config.quotaPerUnit || '';
  el('currency').value = config.currency || ''; el('currency-rate').value = config.currencyRate || '';
  el('organization').replaceChildren();
  const option = document.createElement('option'); option.value = config.organizationId || ''; option.textContent = config.organizationId || '请读取组织列表'; el('organization').appendChild(option);
  const configured = currentState.configured.includes(config.id);
  el('source-secret').placeholder = configured ? '留空保留已保存凭据' : '填写查询凭据';
  el('secret-state').textContent = configured ? '已加密保存凭据；不会回显已保存的密钥。' : '使用当前 Windows 账户加密保存，不上传给本项目。';
  typeChanged();
}
function configFromForm() {
  const config = { id: editingId, name: el('source-name').value.trim(), kind: el('source-kind').value };
  if (config.kind === 'claude') config.organizationId = el('organization').value;
  if (config.kind.startsWith('newapi')) {
    config.baseUrl = el('base-url').value.trim();
    if (config.kind === 'newapi-account') config.userId = el('user-id').value.trim();
    if (el('quota-unit').value) config.quotaPerUnit = Number(el('quota-unit').value);
    if (el('currency').value) config.currency = el('currency').value;
    if (el('currency-rate').value) config.currencyRate = Number(el('currency-rate').value);
  }
  return config;
}
function renderState(state, preferredId) {
  currentState = state;
  renderAttachment(state.attachment);
  el('mode-note').textContent = state.demo ? '模拟模式：不启动 Claude，所有额度都是模拟数据。' : '额度查询与窗口贴附相互独立。只查询你选择的来源。';
  el('source-select').replaceChildren();
  state.preferences.sources.forEach(source => { const option = document.createElement('option'); option.value = source.id; option.textContent = source.name + (source.id === state.preferences.activeId ? ' · 当前使用' : ''); el('source-select').appendChild(option); });
  const selected = state.preferences.sources.find(source => source.id === preferredId) || state.preferences.sources.find(source => source.id === state.preferences.activeId);
  el('source-select').value = selected.id; loadForm(selected); renderAssets(state.assets); renderSnapshot(state.snapshot);
}
el('source-kind').addEventListener('change', typeChanged);
el('source-select').addEventListener('change', () => loadForm(currentState.preferences.sources.find(source => source.id === el('source-select').value)));
el('new-source').addEventListener('click', () => { loadForm({ id: crypto.randomUUID(), name: '新的查询来源', kind: 'claude' }); el('source-name').focus(); message('填写配置后选择“保存并使用”。'); });
el('source-form').addEventListener('submit', event => { event.preventDefault(); void operation(async () => { const config = configFromForm(); const state = await invoke(bridge.save(config, el('source-secret').value.trim())); el('source-secret').value = ''; renderState(state, config.id); message('来源已保存并启用。'); }); });
el('activate-source').addEventListener('click', () => operation(async () => { renderState(await invoke(bridge.activate(el('source-select').value))); message('已切换查询来源。'); }));
el('remove-source').addEventListener('click', () => operation(async () => { renderState(await invoke(bridge.remove(el('source-select').value))); message('来源和已保存凭据已删除。'); }));
el('load-organizations').addEventListener('click', () => operation(async () => {
  const organizations = await invoke(bridge.organizations(editingId, el('source-secret').value.trim()));
  el('organization').replaceChildren();
  if (organizations.length !== 1) { const empty = document.createElement('option'); empty.value = ''; empty.textContent = '请选择对应组织'; el('organization').appendChild(empty); }
  organizations.forEach(org => { const option = document.createElement('option'); option.value = org.id; option.textContent = org.name; el('organization').appendChild(option); });
  message(organizations.length ? '组织列表已读取。请确认与 Desktop 使用同一个账号。' : '没有可用组织，请检查登录会话。', !organizations.length);
}));
el('test-source').addEventListener('click', () => operation(async () => { const data = await invoke(bridge.testSource(configFromForm(), el('source-secret').value.trim())); el('usage-output').textContent = '测试结果（尚未保存）：\n' + formatData(data); message('查询成功；配置仍需保存。'); }));
el('refresh-usage').addEventListener('click', () => operation(async () => { renderSnapshot(await invoke(bridge.refresh())); message('刷新完成。'); }));
el('download-assets').addEventListener('click', () => operation(async () => { message('正在从原版仓库获取素材…'); renderAssets(await invoke(bridge.downloadAssets())); message('原版素材已校验并保存。'); }));
el('import-assets').addEventListener('click', () => operation(async () => { renderAssets(await invoke(bridge.importAssets())); message('素材检查完成。'); }));
el('close-settings').addEventListener('click', () => bridge.closeSettings());
document.addEventListener('keydown', event => { if (event.key === 'Escape') bridge.closeSettings(); });
bridge.onSnapshot(renderSnapshot);
operation(async () => renderState(await invoke(bridge.state())));
// 独立状态读取不刷新额度，也不重新填充正在编辑的来源表单。
const attachmentTimer = setInterval(refreshAttachment, 1000);
window.addEventListener('unload', () => clearInterval(attachmentTimer));
