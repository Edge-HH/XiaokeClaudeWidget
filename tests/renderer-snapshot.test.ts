import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../src/renderer/widget-bridge.js', import.meta.url), 'utf8');
const balance = { kind: 'balance', remaining: 12.5, used: null, total: null, unit: 'CNY', unlimited: false, scope: 'account' };
const snapshot = (provider = 'newapi-account', status = 'ready') => ({ sourceId: provider, sourceName: '账户来源', provider, status, data: balance, observedAt: '2026-01-01T00:00:00Z', message: status === 'stale' ? '查询失败，请检查凭据。' : '' });

function harness() {
  const context = vm.createContext({
    state: { balance: null, todayUsage: null }, shown: null,
    render: vi.fn(), showBubble: vi.fn(), hideBubble: vi.fn(), checkUsageAlerts: vi.fn(),
    bubbleContentText: (_mod: unknown, text: string) => text,
    fmt: (number: number | null, currency: string) => number === null ? '—' : `${number} ${currency}`,
    document: { visibilityState: 'visible' },
    fetch: vi.fn(() => Promise.reject(new Error('离线测试未提供本地账本'))),
    setInterval: vi.fn(), clearInterval: vi.fn(), console,
  });
  vm.runInContext(source, context);
  return context;
}

describe('查询来源在额度泡泡中的显示', () => {
  it('切换账户余额后保留原版白字配套的底色，金额行不能变成白底白字', () => {
    const context = harness();
    context.applyDesktopSnapshot(snapshot());
    const [module] = context.desktopDisplayModules([{ type: 'balance', color: '#ffffff', bgRgb: 'indigo', bg: '', size: 11 }]);
    expect(module.text).toBe('12.5 CNY');
    expect(module.color).toBe('#ffffff');
    expect(module.bgRgb).toBe('indigo');
  });

  it('原版内置 DeepSeek 模块也跟随当前查询来源，不能漏掉账户余额', () => {
    const context = harness();
    context.applyDesktopSnapshot(snapshot());
    expect(context.desktopBubbleRow({ type: 'balance', modelId: 'deepseek' })).toBe('12.5 CNY');
  });

  it('DeepSeek 查询失败保留余额时明确标记旧数据与失败原因', () => {
    const context = harness();
    context.applyDesktopSnapshot(snapshot('deepseek', 'stale'));
    expect(context.desktopBubbleRow({ type: 'today' })).toContain('旧数据');
    expect(context.desktopBubbleRow({ type: 'today' })).toContain('查询失败');
  });

  it('已打开的额度模块在查询失败后原地更新，不再静默显示未标记的旧余额', () => {
    const context = harness();
    const element = { isConnected: true, textContent: '' };
    context.applyDesktopSnapshot(snapshot());
    context.desktopDataRowRegister(element, { type: 'today' });
    context.applyDesktopSnapshot(snapshot('newapi-account', 'stale'));
    expect(element.textContent).toContain('旧数据');
    expect(element.textContent).toContain('查询失败');
    expect(context.showBubble).not.toHaveBeenCalled();
  });

  it('切换查询来源立即收起旧来源泡泡，不能在新来源尚未完成时显示旧额度', () => {
    const context = harness();
    context.applyDesktopSnapshot(snapshot());
    context.applyDesktopSnapshot({ ...snapshot('deepseek', 'loading'), data: null, message: '' });
    expect(context.hideBubble).toHaveBeenCalledOnce();
  });

  it('DeepSeek 来源标题单行省略，完整名称保留在提示中，不能把长名称折到泡泡外', () => {
    const context = harness();
    const sourceName = '很长的余额来源'.repeat(10);
    context.applyDesktopSnapshot({ ...snapshot('deepseek'), sourceName });
    const [module] = context.desktopDisplayModules([{ type: 'text', text: 'DeepSeek 余额', size: 8 }]);
    const element = { isConnected: true, textContent: '', style: {}, title: '' };
    context.desktopDataRowRegister(element, module, element);
    expect(element.style).toMatchObject({ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
    expect(element.title).toContain(sourceName);
    expect(module.text).toContain(sourceName);
    expect(module._desktopLabel).toBe(true);
  });

  it('未适配的旧厂商额度模块明确指向查询来源配置，不能沿用旧余额或一直加载', () => {
    const context = harness();
    context.applyDesktopSnapshot(snapshot());
    expect(context.desktopBubbleRow({ type: 'balance', modelId: 'legacy-provider' })).toBe('请到查询来源配置');
    const [module] = context.desktopDisplayModules([{ type: 'balance', modelId: 'legacy-provider', tpl: '{balance}' }]);
    expect(module.type).toBe('text');
    expect(module.text).toBe('请到查询来源配置');
  });

  it('旧三行泡泡进入随机台词前清除来源标题省略样式，保留原版换行行为', () => {
    const context = harness();
    const element = { style: {}, title: '' };
    context.applyDesktopSnapshot(snapshot());
    context.desktopFitSourceLabel(element);
    context.desktopClearSourceLabel(element);
    expect(element.style).toMatchObject({ maxWidth: '', whiteSpace: '', overflow: '', textOverflow: '', display: '' });
    expect(element.title).toBe('');
  });
});
