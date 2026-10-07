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
