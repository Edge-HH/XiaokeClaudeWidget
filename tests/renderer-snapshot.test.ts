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
});
