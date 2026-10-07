import type { SourceConfig, UsageSnapshot } from '../shared/types.js';
import { QueryError, type UsageProvider } from './providers.js';

export class UsageScheduler {
  private source: SourceConfig;
  private visible = false;
  private controller: AbortController | null = null;
  private inFlight: Promise<UsageSnapshot> | null = null;
  private pendingPrior: UsageSnapshot | null = null;
  private disposed = false;
  private generation = 0;
  private blocked = false;
  private nextAt = 0;
  private failures = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshots = new Map<string, UsageSnapshot>();
  private rateLimits = new Map<string, number>();
  private resetQueried = new Set<string>();
  constructor(private readonly provider: UsageProvider, source: SourceConfig, private readonly getSecret: (id: string) => string, private readonly changed: (snapshot: UsageSnapshot) => void = () => {}, private readonly now: () => number = Date.now) { this.source = source; }
  snapshot(): UsageSnapshot {
    return this.snapshots.get(this.source.id) ?? { sourceId: this.source.id, sourceName: this.source.name, provider: this.source.kind, status: 'unconfigured', observedAt: null, data: null, message: '右键选择查询来源并配置凭据。' };
  }
  private cancelPending() {
    // 中止请求不一定立即结束底层 transport；先解除当前任务，恢复最后完成的数据。
    this.generation++; this.controller?.abort(); this.controller = null; this.inFlight = null;
    if (this.pendingPrior) {
      this.snapshots.set(this.pendingPrior.sourceId, this.pendingPrior);
      this.changed(this.pendingPrior);
      this.pendingPrior = null;
    }
  }
  select(source: SourceConfig, invalidateCache = false) {
    this.cancelPending();
    if (invalidateCache) this.snapshots.delete(source.id);
    this.source = source; this.blocked = false; this.failures = 0; this.nextAt = 0; this.resetQueried.clear();
    this.changed(this.snapshot());
    if (this.visible) void this.refresh();
  }
  setVisible(visible: boolean) {
    if (this.disposed) return;
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible && !this.timer) { this.timer = setInterval(() => void this.refresh(), 1000); this.timer.unref?.(); void this.refresh(); }
    if (!visible) { if (this.timer) clearInterval(this.timer); this.timer = null; this.cancelPending(); }
  }
  private resetDue(): boolean {
    const snapshot = this.snapshot();
    if (snapshot.data?.kind !== 'subscription') return false;
    let due = false;
    for (const row of [snapshot.data.fiveHour, snapshot.data.week]) {
      if (row?.resetsAt && Date.parse(row.resetsAt) <= this.now() && !this.resetQueried.has(row.resetsAt)) { this.resetQueried.add(row.resetsAt); due = true; }
    }
    return due;
  }
  refresh(manual = false): Promise<UsageSnapshot> {
    if (this.disposed) return Promise.resolve(this.snapshot());
    if (this.inFlight) return this.inFlight;
    const prior = this.snapshot();
    if (!manual && (!this.visible || this.blocked)) return Promise.resolve(prior);
    // 只有服务端限流约束手动刷新；网络退避仍允许用户修复连接后立即重试。
    if (this.now() < (this.rateLimits.get(this.source.id) ?? 0)) return Promise.resolve(prior);
    if (!manual && prior.retryAt && this.now() < prior.retryAt) return Promise.resolve(prior);
    if (!manual && this.now() < this.nextAt && !this.resetDue()) return Promise.resolve(prior);
    const source = this.source;
    const generation = this.generation;
    const controller = new AbortController(); this.controller = controller;
    this.pendingPrior = prior;
    const loading: UsageSnapshot = { ...prior, status: 'loading' }; this.snapshots.set(source.id, loading); this.changed(loading);
    const work = (async () => {
      let next: UsageSnapshot;
      let failure: QueryError | null = null;
      try {
        let secret: string;
        try { secret = this.getSecret(source.id); }
        catch { throw new QueryError('configuration', '凭据读取失败，请重新配置。'); }
        if (!secret) throw new QueryError('configuration', '请先配置查询凭据。');
        const data = await this.provider.getSnapshot(source, secret, controller.signal);
        next = { sourceId: source.id, sourceName: source.name, provider: source.kind, status: 'ready', observedAt: new Date(this.now()).toISOString(), data };
      } catch (error) {
        failure = error instanceof QueryError ? error : new QueryError('network', '额度查询失败，请稍后重试。');
        next = { ...prior, status: prior.data ? 'stale' : failure.code === 'configuration' ? 'unconfigured' : 'error', message: failure.message };
      }
      // 切换来源或隐藏期间取消的请求不得覆盖当前数据，也不把取消显示为服务商故障。
      if (generation !== this.generation || controller.signal.aborted) return this.snapshot();
      // 取消的旧请求也不能改退避、限流或下次查询时间。
      if (failure) {
        this.blocked = ['auth', 'blocked', 'configuration'].includes(failure.code);
        this.nextAt = failure.retryAt ?? this.now() + Math.min(900_000, 60_000 * 2 ** Math.min(this.failures++, 4));
        next.retryAt = this.blocked ? undefined : this.nextAt;
        if (failure.code === 'rate-limit') this.rateLimits.set(source.id, this.nextAt);
      } else {
        this.nextAt = this.now() + 60_000; this.failures = 0; this.blocked = false;
        this.rateLimits.delete(source.id);
      }
      this.pendingPrior = null; this.controller = null;
      this.snapshots.set(source.id, next); this.changed(next); return next;
    })();
    this.inFlight = work;
    void work.finally(() => { if (this.inFlight === work) this.inFlight = null; });
    return work;
  }
  dispose() { this.setVisible(false); this.cancelPending(); this.disposed = true; }
}
