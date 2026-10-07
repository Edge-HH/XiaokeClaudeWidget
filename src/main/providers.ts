import type { SourceConfig, UsageData, UsageWindow, Organization } from '../shared/types.js';

export class QueryError extends Error {
  constructor(public code: 'auth' | 'blocked' | 'rate-limit' | 'network' | 'format' | 'configuration', message: string, public retryAt?: number) { super(message); }
}
export type JsonTransport = (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<unknown>;
export interface UsageProvider { getSnapshot(config: SourceConfig, secret: string, signal: AbortSignal): Promise<UsageData> }

type Fetcher = (url: string, options: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'headers' | 'json'>>;
export function createHttpTransport(fetcher: Fetcher = fetch): JsonTransport {
  return async (url, headers, signal) => {
    let response: Pick<Response, 'ok' | 'status' | 'headers' | 'json'>;
    try {
      // 不跟随重定向，防止站点把登录会话或 API Key 转发到另一个地址。
      response = await fetcher(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
    } catch { throw new QueryError('network', '连接失败或请求超时，请检查网络与查询地址。'); }
    if (response.status === 401) throw new QueryError('auth', '登录会话或密钥已失效，请重新配置。');
    if (response.status === 403) throw new QueryError('blocked', '查询被服务端拒绝；请检查会话或站点访问限制。');
    if (response.status === 429) {
      const raw = response.headers.get('retry-after');
      const seconds = raw ? Number(raw) : NaN;
      const date = raw ? Date.parse(raw) : NaN;
      const retryAt = Number.isFinite(seconds) ? Date.now() + Math.max(1, seconds) * 1000 : Number.isFinite(date) ? Math.max(Date.now() + 1000, date) : Date.now() + 60_000;
      throw new QueryError('rate-limit', '查询次数受限，稍后自动重试。', retryAt);
    }
    if (!response.ok) throw new QueryError('network', `额度接口暂不可用（HTTP ${response.status}）。`);
    try { return await response.json(); } catch { throw new QueryError('format', '额度接口未返回有效 JSON，可能需要重新登录或更新适配器。'); }
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QueryError('format', '额度接口格式已变化。');
  return value as Record<string, unknown>;
}
function amount(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') throw new QueryError('format', '额度接口缺少有效数值。');
  const n = Number(value);
  if (!Number.isFinite(n)) throw new QueryError('format', '额度接口包含无效数值。');
  return n;
}
function windowOf(value: unknown): UsageWindow | null {
  if (value == null) return null;
  const row = object(value);
  const n = amount(row.utilization ?? row.percent);
  if (n < 0 || n > 100) throw new QueryError('format', '订阅用量比例超出有效范围。');
  const reset = row.resets_at;
  if (reset != null && (typeof reset !== 'string' || !Number.isFinite(Date.parse(reset)))) throw new QueryError('format', '额度重置时间格式无效。');
  return { usedPercent: n, resetsAt: typeof reset === 'string' ? reset : null };
}
export function parseClaudeUsage(value: unknown): UsageData {
  const body = object(value);
  const limits = Array.isArray(body.limits) ? body.limits : [];
  const find = (kind: string) => limits.find(row => row && typeof row === 'object' && (row as Record<string, unknown>).kind === kind);
  const fiveHour = windowOf(body.five_hour ?? find('session'));
  const week = windowOf(body.seven_day ?? find('weekly_all'));
  if (!fiveHour && !week) throw new QueryError('format', '接口没有五小时或周额度，账号可能不支持此统计。');
  return { kind: 'subscription', fiveHour, week };
}
export function parseDeepSeekBalance(value: unknown): UsageData {
  const body = object(value);
  if (!Array.isArray(body.balance_infos) || !body.balance_infos.length) throw new QueryError('format', '接口没有返回余额钱包。');
  const wallets = body.balance_infos.map(object);
  const selected = wallets.find(w => w.currency === 'CNY' && amount(w.total_balance) > 0) ?? wallets.find(w => amount(w.total_balance) > 0) ?? wallets.find(w => w.currency === 'CNY') ?? wallets[0];
  if (typeof selected.currency !== 'string' || !selected.currency) throw new QueryError('format', '余额接口缺少币种。');
  return { kind: 'balance', remaining: amount(selected.total_balance), used: null, total: null, unit: selected.currency, unlimited: false, scope: 'account' };
}
export function endpoint(config: SourceConfig, suffix: string): string {
  if (!config.baseUrl) throw new QueryError('configuration', '请填写 New API 站点地址。');
  let base: URL;
  try { base = new URL(config.baseUrl); } catch { throw new QueryError('configuration', '站点地址无效。'); }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new QueryError('configuration', '站点地址须为 HTTP(S) 地址，不能包含密码、查询参数或片段。');
  return base.toString().replace(/\/$/, '') + suffix;
}
export function parseNewApiUsage(value: unknown, metadata: unknown, config: SourceConfig): UsageData {
  const body = object(value);
  if (body.success === false || body.code === false) throw new QueryError('auth', 'New API 拒绝查询，请核对凭据与用户 ID。');
  const data = object(body.data);
  const status = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).data : null;
  const meta = status && typeof status === 'object' ? status as Record<string, unknown> : {};
  const divisor = config.quotaPerUnit ?? Number(meta.quota_per_unit);
  let unit = '额度';
  let rate = 1;
  const type = config.currency ?? String(meta.quota_display_type ?? (meta.display_in_currency === true ? 'USD' : 'QUOTA'));
  if (Number.isFinite(divisor) && divisor > 0) {
    if (type === 'USD') unit = 'USD';
    else if (type === 'CNY' && Number(config.currencyRate ?? meta.usd_exchange_rate) > 0) { unit = 'CNY'; rate = Number(config.currencyRate ?? meta.usd_exchange_rate); }
    else if (type === 'CUSTOM' && Number(config.currencyRate ?? meta.custom_currency_exchange_rate) > 0 && typeof meta.custom_currency_symbol === 'string') { unit = meta.custom_currency_symbol; rate = Number(config.currencyRate ?? meta.custom_currency_exchange_rate); }
  }
  const convert = (v: unknown) => amount(v) * (unit === '额度' ? 1 : rate / divisor);
  const token = config.kind === 'newapi-token';
  const unlimited = token && data.unlimited_quota === true;
  return {
    kind: 'balance', scope: token ? 'token' : 'account', unlimited, unit,
    remaining: unlimited ? null : convert(token ? data.total_available : data.quota),
    used: convert(token ? data.total_used : data.used_quota),
    total: token && !unlimited ? convert(data.total_granted) : null,
  };
}
export class Providers implements UsageProvider {
  constructor(private readonly transport: JsonTransport, private readonly options: { allowClaude?: boolean } = {}) {}
  async organizations(secret: string, signal: AbortSignal): Promise<Organization[]> {
    if (this.options.allowClaude === false) throw new QueryError('configuration', '测试和演示模式不执行 Claude 查询。');
    const result = await this.transport('https://claude.ai/api/organizations', this.claudeHeaders(secret), signal);
    if (!Array.isArray(result)) throw new QueryError('format', '组织列表格式已变化。');
    return result.map(object).map(row => ({ id: String(row.uuid ?? row.id ?? ''), name: String(row.name ?? '个人账户') })).filter(row => /^[\w-]+$/.test(row.id));
  }
  private claudeHeaders(secret: string) {
    if (/\r|\n|;/.test(secret)) throw new QueryError('configuration', '请仅填写 sessionKey 的值，不要填写完整 Cookie。');
    return { Cookie: `sessionKey=${secret}`, Accept: 'application/json' };
  }
  async getSnapshot(config: SourceConfig, secret: string, signal: AbortSignal): Promise<UsageData> {
    if (!secret) throw new QueryError('configuration', '请先配置查询凭据。');
    if (config.kind === 'claude') {
      if (this.options.allowClaude === false) throw new QueryError('configuration', '测试和演示模式不执行 Claude 查询。');
      if (!config.organizationId || !/^[\w-]+$/.test(config.organizationId)) throw new QueryError('configuration', '请先选择 Claude 组织。');
      return parseClaudeUsage(await this.transport(`https://claude.ai/api/organizations/${config.organizationId}/usage`, this.claudeHeaders(secret), signal));
    }
    if (config.kind === 'deepseek') return parseDeepSeekBalance(await this.transport('https://api.deepseek.com/user/balance', { Authorization: `Bearer ${secret}` }, signal));
    const headers: Record<string, string> = { Authorization: `Bearer ${secret}` };
    if (config.kind === 'newapi-account') {
      if (!config.userId || !/^\d+$/.test(config.userId)) throw new QueryError('configuration', '账户查询需要填写数字用户 ID。');
      headers['New-Api-User'] = config.userId;
    }
    const usage = await this.transport(endpoint(config, config.kind === 'newapi-token' ? '/api/usage/token/' : '/api/user/self'), headers, signal);
    let metadata: unknown = null;
    try { metadata = await this.transport(endpoint(config, '/api/status'), {}, signal); } catch { /* 站点没有公开换算参数时，保留原始额度。 */ }
    return parseNewApiUsage(usage, metadata, config);
  }
}

/** 演示和测试完全不连接服务商；地址仅用于选择本地响应，不执行 fetch。 */
export function createMockTransport(): JsonTransport {
  return async (url, _headers, signal) => {
    if (signal.aborted) throw new QueryError('network', '查询已取消。');
    if (url.endsWith('/api/organizations')) return [{ uuid: 'demo-account', name: '演示账户（模拟数据）' }];
    if (url.includes('/usage') && url.startsWith('https://claude.ai/')) return { five_hour: { utilization: 32, resets_at: new Date(Date.now() + 2 * 3600_000).toISOString() }, seven_day: { utilization: 61, resets_at: new Date(Date.now() + 3 * 86400_000).toISOString() } };
    if (url.includes('/user/balance')) return { balance_infos: [{ currency: 'CNY', total_balance: '42.50' }] };
    if (url.endsWith('/api/status')) return { data: { quota_per_unit: 500_000, quota_display_type: 'USD' } };
    if (url.endsWith('/api/user/self')) return { success: true, data: { quota: 4_000_000, used_quota: 1_000_000 } };
    return { code: true, data: { total_available: 4_000_000, total_used: 1_000_000, total_granted: 5_000_000, unlimited_quota: false } };
  };
}
