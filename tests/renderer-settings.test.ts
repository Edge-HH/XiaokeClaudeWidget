import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../src/renderer/settings.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/renderer/settings.html', import.meta.url), 'utf8');
const data = { kind: 'balance', remaining: 12, used: null, total: null, unit: 'CNY', unlimited: false, scope: 'account' };
const snapshot = { sourceId: 'deepseek', sourceName: '余额来源', provider: 'deepseek', status: 'ready', data, observedAt: null };
const state = { demo: true, configured: ['deepseek'], preferences: { activeId: 'deepseek', sources: [{ id: 'deepseek', name: '余额来源', kind: 'deepseek' }] }, assets: { ready: true }, attachment: { message: '已贴附', helper: 'running' }, snapshot };

class Element {
  value = '';
  textContent = '';
  disabled = false;
  hidden = false;
  required = false;
  dataset: Record<string, string> = {};
  children: Element[] = [];
  listeners = new Map<string, Array<(event: { preventDefault(): void }) => unknown>>();
  constructor(readonly tagName: string, readonly id = '') {}
  addEventListener(name: string, listener: (event: { preventDefault(): void }) => unknown) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  dispatch(name: string) { this.listeners.get(name)?.forEach(listener => listener({ preventDefault() {} })); }
  appendChild(child: Element) { this.children.push(child); if (this.tagName === 'SELECT' && this.children.length === 1) this.value = child.value; }
  replaceChildren() { this.children = []; this.value = ''; }
  focus() {}
  reportValidity = vi.fn(() => true);
}

async function harness(overrides: Record<string, unknown> = {}) {
  const elements = new Map<string, Element>();
  for (const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2], new Element(match[1].toUpperCase(), match[2]));
  const bridge = {
    state: vi.fn(async () => ({ ok: true, value: structuredClone(state) })),
    onSnapshot: vi.fn(), attachment: vi.fn(), closeSettings: vi.fn(),
    refresh: vi.fn(async () => ({ ok: true, value: snapshot })),
    testSource: vi.fn(async () => ({ ok: true, value: data })),
    save: vi.fn(async () => ({ ok: true, value: structuredClone(state) })),
    ...overrides,
  };
  const context = vm.createContext({
    window: { desktopBridge: bridge, addEventListener: vi.fn() },
    document: {
      getElementById: (id: string) => elements.get(id), createElement: (tag: string) => new Element(tag.toUpperCase()), addEventListener: vi.fn(),
      querySelectorAll: (selector: string) => [...elements.values()].filter(element => selector.split(',').map(tag => tag.trim().toUpperCase()).includes(element.tagName)),
    },
    crypto: { randomUUID: () => 'new-id' }, setInterval: vi.fn(), clearInterval: vi.fn(), console,
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  return { context, bridge, el: (id: string) => elements.get(id)! };
}

describe('查询来源设置页', () => {
  it('查询失败保留旧数据时显示失败，不能把刷新动作当作查询成功', async () => {
    const ui = await harness({ refresh: vi.fn(async () => ({ ok: true, value: { ...snapshot, status: 'stale', message: '凭据已过期。' } })) });
    ui.el('refresh-usage').dispatch('click');
    await new Promise(setImmediate);
    expect(ui.el('status').textContent).toContain('凭据已过期');
    expect(ui.el('status').dataset.error).toBe('true');
    expect(ui.el('observed-at').textContent).toContain('旧数据');
  });

  it('操作进行中锁住来源表单，关闭设置仍可用，完成后恢复原来的禁用状态', async () => {
    let resolve!: (value: unknown) => void;
    const ui = await harness({ refresh: vi.fn(() => new Promise(done => { resolve = done; })) });
    ui.el('download-assets').disabled = true;
    ui.el('refresh-usage').dispatch('click');
    expect(ui.el('source-select').disabled).toBe(true);
    expect(ui.el('source-kind').disabled).toBe(true);
    expect(ui.el('source-secret').disabled).toBe(true);
    expect(ui.el('close-settings').disabled).toBe(false);
    resolve({ ok: true, value: snapshot });
    await new Promise(setImmediate);
    expect(ui.el('source-secret').disabled).toBe(false);
    expect(ui.el('download-assets').disabled).toBe(true);
  });

  it('模拟模式新增来源默认 DeepSeek', async () => {
    const ui = await harness();
    ui.el('new-source').dispatch('click');
    expect(ui.el('source-kind').value).toBe('deepseek');
  });

  it('新增未保存来源时不能误删除或激活旧来源，切回已保存来源后恢复操作', async () => {
    const ui = await harness();
    ui.el('new-source').dispatch('click');
    expect(ui.el('source-select').value).toBe('');
    expect(ui.el('remove-source').disabled).toBe(true);
    expect(ui.el('activate-source').disabled).toBe(true);
    ui.el('source-select').value = 'deepseek';
    ui.el('source-select').dispatch('change');
    expect(ui.el('remove-source').disabled).toBe(false);
    expect(ui.el('activate-source').disabled).toBe(false);
  });

  it('New API 账户的用户 ID 为兼容旧站点的可选字段', async () => {
    const ui = await harness();
    ui.el('source-kind').value = 'newapi-account';
    ui.el('source-kind').dispatch('change');
    expect(ui.el('user-id').required).toBe(false);
  });

  it('测试查询拒绝无效表单，成功结果注明测试来源，不沿用当前来源时间', async () => {
    const ui = await harness();
    ui.el('source-form').reportValidity.mockReturnValueOnce(false);
    ui.el('test-source').dispatch('click');
    await new Promise(setImmediate);
    expect(ui.bridge.testSource).not.toHaveBeenCalled();
    ui.el('source-name').value = '另一个账户';
    ui.el('test-source').dispatch('click');
    await new Promise(setImmediate);
    expect(ui.el('observed-at').textContent).toContain('另一个账户');
    expect(ui.el('observed-at').textContent).toContain('尚未保存');
  });
});
