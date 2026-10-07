import { it, expect } from 'vitest';
import { UsageScheduler } from '../src/main/scheduler.js';
import { QueryError } from '../src/main/providers.js';
import type { UsageData } from '../src/shared/types.js';
const source = { id: 'deepseek', name: 'DeepSeek', kind: 'deepseek' as const };
const data: UsageData = { kind: 'balance', remaining: 32, used: null, total: null, unit: 'CNY', unlimited: false, scope: 'account' };
it('隐藏时不查询，正常缓存每分钟刷新，错误保留旧数据', async () => {
  let now = 0, count = 0, fail = false;
  const scheduler = new UsageScheduler({ getSnapshot: async () => { count++; if (fail) throw new QueryError('network', '模拟网络失败'); return data; } }, source, () => 'mock', () => {}, () => now);
  await scheduler.refresh(); expect(count).toBe(0);
  await scheduler.refresh(true); expect(count).toBe(1);
  scheduler.setVisible(true); await scheduler.refresh(); expect(count).toBe(1);
  now = 60_001; fail = true; await scheduler.refresh();
  expect(scheduler.snapshot()).toMatchObject({ status: 'stale', data });
  scheduler.setVisible(false); now = 200_000; await scheduler.refresh(); expect(count).toBe(2);
  scheduler.dispose();
});
it('限流期间手动刷新也不绕过重试时间', async () => {
  let now = 0, count = 0;
  const scheduler = new UsageScheduler({ getSnapshot: async () => { count++; throw new QueryError('rate-limit', '限流', 120_000); } }, source, () => 'mock', () => {}, () => now);
  await scheduler.refresh(true); await scheduler.refresh(true); expect(count).toBe(1);
  now = 120_001; await scheduler.refresh(true); expect(count).toBe(2); scheduler.dispose();
});
it('切换来源后旧请求不能覆盖新的额度', async () => {
  let resolveOld!: (data: UsageData) => void;
  const scheduler = new UsageScheduler({ getSnapshot: config => config.id === 'deepseek' ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve({ ...data, remaining: 70 }) }, source, () => 'mock');
  const old = scheduler.refresh(true);
  scheduler.select({ ...source, id: 'second' }); await scheduler.refresh(true);
  resolveOld(data); await old;
  expect(scheduler.snapshot()).toMatchObject({ sourceId: 'second', data: { remaining: 70 } }); scheduler.dispose();
});
it.skip('本次禁止测试订阅路径：倒计时到期触发重新查询，不直接清零额度', async () => {
  let now = 0, count = 0;
  const scheduler = new UsageScheduler({ getSnapshot: async () => { count++; return { kind: 'subscription', fiveHour: { usedPercent: 32, resetsAt: new Date(20_000).toISOString() }, week: null }; } }, source, () => 'mock', () => {}, () => now);
  await scheduler.refresh(true); scheduler.setVisible(true);
  now = 20_001; await scheduler.refresh(); expect(count).toBe(2);
  expect(scheduler.snapshot()).toMatchObject({ data: { fiveHour: { usedPercent: 32 } } }); scheduler.dispose();
});
it('隐藏取消的查询不阻塞重新显示，旧请求不能修改新查询的重试节奏', async () => {
  let now = 0, count = 0;
  let resolveOld!: (data: UsageData) => void;
  const scheduler = new UsageScheduler({ getSnapshot: () => {
    count++;
    return count === 1 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(data);
  } }, source, () => 'mock', () => {}, () => now);
  const old = scheduler.refresh(true);
  scheduler.setVisible(true);
  scheduler.setVisible(false);
  scheduler.setVisible(true);
  await Promise.resolve(); await Promise.resolve();
  expect(count).toBe(2);
  expect(scheduler.snapshot()).toMatchObject({ status: 'ready', data });
  now = 59_999; resolveOld(data); await old;
  now = 60_001; await scheduler.refresh();
  expect(count).toBe(3);
  scheduler.dispose();
});
it('隐藏时恢复上次完成的余额快照，取消不留下永久查询中', async () => {
  let count = 0;
  let resolvePending!: (data: UsageData) => void;
  const scheduler = new UsageScheduler({ getSnapshot: () => ++count === 1 ? Promise.resolve(data) : new Promise(resolve => { resolvePending = resolve; }) }, source, () => 'mock');
  await scheduler.refresh(true);
  scheduler.setVisible(true);
  const pending = scheduler.refresh(true);
  expect(scheduler.snapshot().status).toBe('loading');
  scheduler.setVisible(false);
  expect(scheduler.snapshot()).toMatchObject({ status: 'ready', data });
  resolvePending(data); await pending;
  expect(scheduler.snapshot()).toMatchObject({ status: 'ready', data });
  scheduler.dispose();
});
it('临时网络失败后允许立即手动重试，仍由自动查询遵守退避', async () => {
  let count = 0;
  const scheduler = new UsageScheduler({ getSnapshot: async () => {
    if (++count === 1) throw new QueryError('network', '网络暂时不可用');
    return data;
  } }, source, () => 'mock');
  await scheduler.refresh(true);
  await scheduler.refresh(true);
  expect(count).toBe(2);
  expect(scheduler.snapshot()).toMatchObject({ status: 'ready', data });
  scheduler.dispose();
});
it('来源切换保留已查询余额，返回时再重新查询', async () => {
  let fail = false;
  const scheduler = new UsageScheduler({ getSnapshot: async () => {
    if (fail) throw new QueryError('network', '网络暂时不可用');
    return data;
  } }, source, () => 'mock');
  await scheduler.refresh(true);
  scheduler.select({ ...source, id: 'other' }, false);
  scheduler.select(source, false);
  expect(scheduler.snapshot()).toMatchObject({ status: 'ready', data });
  fail = true; await scheduler.refresh(true);
  expect(scheduler.snapshot()).toMatchObject({ status: 'stale', data });
  scheduler.dispose();
});
it('provider 的意外异常显示可重试查询错误，不冒充凭据解密故障', async () => {
  let now = 0, count = 0;
  const scheduler = new UsageScheduler({ getSnapshot: async () => {
    if (++count === 1) throw new Error('意外响应解析错误');
    return data;
  } }, source, () => 'mock', () => {}, () => now);
  await scheduler.refresh(true);
  expect(scheduler.snapshot()).toMatchObject({ status: 'error' });
  scheduler.setVisible(true); now = 60_001; await scheduler.refresh();
  expect(count).toBe(2);
  expect(scheduler.snapshot()).toMatchObject({ status: 'ready', data });
  scheduler.dispose();
});
