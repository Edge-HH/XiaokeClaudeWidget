import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { Providers, parseClaudeUsage, parseDeepSeekBalance, parseNewApiUsage, QueryError, createHttpTransport, createMockTransport } from '../src/main/providers.js';
import type { SourceConfig } from '../src/shared/types.js';

const token: SourceConfig = { id: 'token', name: '中转令牌', kind: 'newapi-token', baseUrl: 'https://example.invalid' };
describe('查询来源与额度口径', () => {
  it.skip('本次禁止测试 Claude：订阅额度保持百分比并允许单个窗口缺失', () => {
    expect(parseClaudeUsage({ five_hour: null, seven_day: { utilization: 100, resets_at: null } })).toEqual({ kind: 'subscription', fiveHour: null, week: { usedPercent: 100, resetsAt: null } });
    expect(() => parseClaudeUsage({ five_hour: { utilization: 'oops' } })).toThrow(QueryError);
    expect(() => parseClaudeUsage({})).toThrow(QueryError);
    expect(() => parseClaudeUsage({ five_hour: { utilization: 12, resets_at: 'invalid' } })).toThrow(QueryError);
  });
  it.skip('本次禁止测试 Claude：支持 limits 数组的会话与周窗口，忽略模型专用窗口', () => {
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
  it('非 Claude 来源可以通过本地模拟 transport 验证，不联网', async () => {
    const providers = new Providers(createMockTransport(), { allowClaude: false });
    expect(await providers.getSnapshot({ id: 'deepseek', name: '模拟余额', kind: 'deepseek' }, 'mock', new AbortController().signal)).toMatchObject({ kind: 'balance', remaining: 42.5 });
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

describe('非 Claude 查询回归', () => {
  const deepseek: SourceConfig = { id: 'deepseek', name: '余额', kind: 'deepseek' };
  it('API Key 接受常见 Bearer 前缀，发送前去掉外部空白', async () => {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const providers = new Providers(async (url, headers) => {
      requests.push({ url, headers });
      return { balance_infos: [{ currency: 'CNY', total_balance: '12.50' }] };
    }, { allowClaude: false });
    await providers.getSnapshot(deepseek, '  Bearer sk-local-fixture  ', new AbortController().signal);
    expect(requests).toEqual([{ url: 'https://api.deepseek.com/user/balance', headers: { Authorization: 'Bearer sk-local-fixture', Accept: 'application/json' } }]);
  });
  it('非法 API Key 在 transport 前明确报配置错误，不变成网络错误', async () => {
    let count = 0;
    const providers = new Providers(async () => { count++; return {}; }, { allowClaude: false });
    for (const secret of ['Bearer ', 'two keys', 'sk-fixture\n']) {
      await expect(providers.getSnapshot(deepseek, secret, new AbortController().signal)).rejects.toMatchObject({ code: 'configuration' });
    }
    expect(count).toBe(0);
  });
  it('New API 面板访问令牌允许省略新版不要求的用户 ID', async () => {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const providers = new Providers(async (url, headers) => {
      requests.push({ url, headers });
      return url.endsWith('/api/status') ? { data: {} } : { success: true, data: { quota: 123, used_quota: 45 } };
    }, { allowClaude: false });
    await expect(providers.getSnapshot({ ...token, kind: 'newapi-account' }, 'nap_local-fixture', new AbortController().signal)).resolves.toMatchObject({ scope: 'account', remaining: 123 });
    expect(requests[0].headers).not.toHaveProperty('New-Api-User');
    await providers.getSnapshot({ ...token, kind: 'newapi-account', userId: '12' }, 'local-fixture', new AbortController().signal);
    expect(requests[2].headers['New-Api-User']).toBe('12');
  });
  it('New API 站点复制 /v1 模型地址时在发出凭据前提示根地址', async () => {
    let count = 0;
    const providers = new Providers(async () => { count++; return {}; }, { allowClaude: false });
    await expect(providers.getSnapshot({ ...token, baseUrl: 'https://example.invalid/v1/' }, 'local-fixture', new AbortController().signal)).rejects.toMatchObject({ code: 'configuration', message: expect.stringContaining('根地址') });
    expect(count).toBe(0);
  });
  it('空白额度不能转换成零余额，站点无限或缺失汇率不能变成无限金额', () => {
    const payload = { data: { total_available: 500_000, total_used: 0, total_granted: 500_000 } };
    expect(() => parseDeepSeekBalance({ balance_infos: [{ currency: 'CNY', total_balance: '   ' }] })).toThrow(QueryError);
    expect(parseNewApiUsage(payload, { data: { quota_per_unit: 500_000, quota_display_type: 'CNY', usd_exchange_rate: 'Infinity' } }, token)).toMatchObject({ unit: '额度', remaining: 500_000 });
    expect(parseNewApiUsage(payload, { data: { quota_per_unit: 500_000, quota_display_type: 'CUSTOM', custom_currency_exchange_rate: 7, custom_currency_symbol: '' } }, token)).toMatchObject({ unit: '额度', remaining: 500_000 });
  });
  it('New API 服务端临时故障可重试，明确无效令牌仍提示重新配置', () => {
    expect(() => parseNewApiUsage({ success: false, message: '数据库连接失败' }, null, token)).toThrow(expect.objectContaining({ code: 'network' }));
    expect(() => parseNewApiUsage({ success: false, message: 'Invalid token' }, null, token)).toThrow(expect.objectContaining({ code: 'auth' }));
  });
  it('响应正文读取被取消时显示网络错误，不误报接口格式变化', async () => {
    const controller = new AbortController();
    const transport = createHttpTransport(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => { controller.abort(); throw new Error('读取取消'); } }));
    await expect(transport('http://127.0.0.1/fixture', {}, controller.signal)).rejects.toMatchObject({ code: 'network' });
  });
  it('站点换算参数查询失败时保留已成功的原始额度', () => {
    const payload = { data: { total_available: 500_000, total_used: 0, total_granted: 500_000 } };
    expect(parseNewApiUsage(payload, { success: false, data: { quota_per_unit: 500_000, quota_display_type: 'USD' } }, token)).toMatchObject({ unit: '额度', remaining: 500_000 });
  });
  it('New API 子路径保留，连续尾斜杠规范化，元数据请求不发送 API Key', async () => {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const providers = new Providers(async (url, headers) => {
      requests.push({ url, headers });
      if (url.endsWith('/api/status')) throw new QueryError('network', '参数暂时不可用');
      return { data: { total_available: 100, total_used: 50, total_granted: 150 } };
    }, { allowClaude: false });
    await expect(providers.getSnapshot({ ...token, baseUrl: 'https://example.invalid/gateway///' }, 'Bearer local-fixture', new AbortController().signal)).resolves.toMatchObject({ unit: '额度', remaining: 100 });
    expect(requests.map(request => request.url)).toEqual(['https://example.invalid/gateway/api/usage/token/', 'https://example.invalid/gateway/api/status']);
    expect(requests[1].headers).toEqual({});
  });
});
