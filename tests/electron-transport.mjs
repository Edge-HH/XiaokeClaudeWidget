import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Providers, QueryError, createHttpTransport } from '../dist/main/providers.js';

// 验证生产使用的 Electron HTTP transport，但服务端只有本机假余额，不连接服务商。
const requests = [];
const server = createServer((request, response) => {
  requests.push({ path: request.url, authorization: request.headers.authorization, userId: request.headers['new-api-user'] });
  response.setHeader('content-type', 'application/json');
  if (request.url === '/balance') response.end(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '42.50' }] }));
  else if (request.url === '/api/status') response.end(JSON.stringify({ success: true, data: { quota_per_unit: 500_000, quota_display_type: 'USD' } }));
  else if (request.url === '/api/user/self') response.end(JSON.stringify({ success: true, data: { quota: 4_000_000, used_quota: 1_000_000 } }));
  else if (request.url === '/api/usage/token/') response.end(JSON.stringify({ code: true, data: { total_available: 4_000_000, total_used: 1_000_000, total_granted: 5_000_000 } }));
  else { response.writeHead(401); response.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const directory = path.resolve('.test-artifacts', 'electron-transport-' + Date.now());
await mkdir(directory, { recursive: true });
const application = await electron.launch({ args: ['.', '--demo', '--test', '--user-data', directory], timeout: 30_000 });
const watchdog = setTimeout(() => application.process().kill(), 30_000);
try {
  const transport = async (url, headers, signal) => {
    if (signal.aborted) throw new Error('测试查询已取消');
    const target = url === 'https://api.deepseek.com/user/balance' ? base + '/balance' : url;
    assert.equal(new URL(target).origin, base, '测试只允许本机 fixture');
    const result = await application.evaluate(async ({ session }, input) => {
      // Playwright evaluate 不支持 ESM import；执行构建产物的真实函数源码，避免维护另一份 transport 实现。
      const QueryError = new Function('return (' + input.errorClass + ')')();
      const createHttpTransport = new Function('QueryError', 'return (' + input.factory + ')')(QueryError);
      const local = session.fromPartition('xiaoke-loopback-transport-test');
      local.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).origin !== input.base }));
      const http = createHttpTransport((url, options) => local.fetch(url, options));
      try { return { ok: true, value: await http(input.target, input.headers, new AbortController().signal) }; }
      catch (error) { return { ok: false, code: error.code, message: error.message, retryAt: error.retryAt }; }
    }, { base, target, headers, errorClass: QueryError.toString(), factory: createHttpTransport.toString() });
    if (!result.ok) throw new QueryError(result.code, result.message, result.retryAt);
    return result.value;
  };
  const providers = new Providers(transport, { allowClaude: false });
  const signal = () => new AbortController().signal;
  const results = {
    deepseek: await providers.getSnapshot({ id: 'deepseek-test', name: '本机余额', kind: 'deepseek' }, 'Bearer mock-key', signal()),
    token: await providers.getSnapshot({ id: 'token-test', name: '本机令牌', kind: 'newapi-token', baseUrl: base }, 'mock-key', signal()),
    account: await providers.getSnapshot({ id: 'account-test', name: '本机账户', kind: 'newapi-account', baseUrl: base }, 'mock-key', signal()),
  };
  try { await transport(base + '/unauthorized', {}, signal()); } catch (failure) { results.error = failure.code; }
  assert.equal(results.deepseek.remaining, 42.5);
  assert.deepEqual([results.token.scope, results.token.remaining], ['token', 8]);
  assert.deepEqual([results.account.scope, results.account.remaining], ['account', 8]);
  assert.equal(results.error, 'auth');
  assert.equal(requests.find(request => request.path === '/balance').authorization, 'Bearer mock-key');
  assert.equal(requests.find(request => request.path === '/api/user/self').userId, undefined);
  console.log('Electron HTTP transport 本机接口验收通过：DeepSeek、New API 令牌／账户、401，未连接任何服务商。');
} finally {
  await application.evaluate(({ app }) => app.quit()).catch(() => {});
  await application.close().catch(() => {});
  clearTimeout(watchdog);
  await new Promise(resolve => server.close(resolve));
}
