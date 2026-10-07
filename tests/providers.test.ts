import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { Providers, parseClaudeUsage, parseDeepSeekBalance, parseNewApiUsage, QueryError, createHttpTransport, createMockTransport } from '../src/main/providers.js';
import type { SourceConfig } from '../src/shared/types.js';

const token: SourceConfig = { id: 'token', name: '中转令牌', kind: 'newapi-token', baseUrl: 'https://example.invalid' };
describe('查询来源与额度口径', () => {
  it('订阅额度保持百分比并允许单个窗口缺失', () => {
    expect(parseClaudeUsage({ five_hour: null, seven_day: { utilization: 100, resets_at: null } })).toEqual({ kind: 'subscription', fiveHour: null, week: { usedPercent: 100, resetsAt: null } });
    expect(() => parseClaudeUsage({ five_hour: { utilization: 'oops' } })).toThrow(QueryError);
    expect(() => parseClaudeUsage({})).toThrow(QueryError);
    expect(() => parseClaudeUsage({ five_hour: { utilization: 12, resets_at: 'invalid' } })).toThrow(QueryError);
  });
  it('支持 limits 数组的会话与周窗口，忽略模型专用窗口', () => {
    expect(parseClaudeUsage({ limits: [{ kind: 'session', percent: 32, resets_at: null }, { kind: 'weekly_all', percent: 61, resets_at: null }, { kind: 'weekly_scoped', percent: 90 }] })).toMatchObject({ fiveHour: { usedPercent: 32 }, week: { usedPercent: 61 } });
  });
  it('DeepSeek 优先人民币钱包并保留其他钱包币种', () => {
    expect(parseDeepSeekBalance({ balance_infos: [{ currency: 'USD', total_balance: '3' }, { currency: 'CNY', total_balance: '12.3456' }] })).toMatchObject({ unit: 'CNY', remaining: 12.3456, used: null });
    expect(parseDeepSeekBalance({ balance_infos: [{ currency: 'USD', total_balance: '4' }] })).toMatchObject({ unit: 'USD', remaining: 4 });
  });
  it('New API 参数不足时使用原始额度；明确单位时才换算', () => {
    const payload = { data: { total_available: 4_000_000, total_used: 1_000_000, total_granted: 5_000_000 } };
    expect(parseNewApiUsage(payload, null, token)).toMatchObject({ unit: '额度', remaining: 4_000_000, scope: 'token' });
    expect(parseNewApiUsage(payload, { data: { quota_per_unit: 500_000, quota_display_type: 'USD' } }, token)).toMatchObject({ unit: 'USD', remaining: 8, used: 2, total: 10 });
    expect(parseNewApiUsage(payload, { data: { quota_per_unit: 500_000, quota_display_type: 'CNY', usd_exchange_rate: 7 } }, token)).toMatchObject({ unit: 'CNY', remaining: 56 });
  });
  it('无限令牌不冒充无限账户余额', () => {
    expect(parseNewApiUsage({ data: { unlimited_quota: true, total_used: 50 } }, null, token)).toMatchObject({ unlimited: true, remaining: null, total: null, scope: 'token' });
    expect(parseNewApiUsage({ data: { quota: 0, used_quota: 100 } }, null, { ...token, kind: 'newapi-account' })).toMatchObject({ unlimited: false, remaining: 0, used: 100, scope: 'account' });
  });
  it('所有来源都可以通过本地模拟 transport 验证，不联网', async () => {
    const providers = new Providers(createMockTransport());
    expect(await providers.organizations('mock', new AbortController().signal)).toHaveLength(1);
    expect(await providers.getSnapshot({ id: 'claude', name: '模拟账号', kind: 'claude', organizationId: 'demo-account' }, 'mock', new AbortController().signal)).toMatchObject({ kind: 'subscription', fiveHour: { usedPercent: 32 } });
    expect(await providers.getSnapshot({ ...token, kind: 'newapi-account', userId: '12' }, 'mock', new AbortController().signal)).toMatchObject({ scope: 'account', remaining: 8 });
  });
});

describe('真实 transport 的错误处理仅使用本机 HTTP 服务', () => {
  it('区分 401、403、429、错误 JSON，且不跟随带凭据重定向', async () => {
    let redirected = false;
    const server = createServer((req, res) => {
      if (req.url === '/401') { res.writeHead(401); res.end(); }
      else if (req.url === '/403') { res.writeHead(403); res.end(); }
      else if (req.url === '/429') { res.writeHead(429, { 'retry-after': '120' }); res.end(); }
      else if (req.url === '/redirect') { res.writeHead(302, { location: '/target' }); res.end(); }
      else if (req.url === '/target') { redirected = true; res.end('{}'); }
      else res.end('<html>登录</html>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const transport = createHttpTransport();
    try {
      await expect(transport(base + '/401', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'auth' });
      await expect(transport(base + '/403', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'blocked' });
      await expect(transport(base + '/429', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'rate-limit', retryAt: expect.any(Number) });
      await expect(transport(base + '/invalid', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'format' });
      await expect(transport(base + '/redirect', { Authorization: 'mock-secret' }, new AbortController().signal)).rejects.toMatchObject({ code: 'network' });
      expect(redirected).toBe(false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
