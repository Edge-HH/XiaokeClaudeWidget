import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { HostGeometry } from '../shared/types.js';

/** 原生组件只输出窗口元数据；演示模式只观察传入的本项目模拟窗口句柄。 */
export class WindowTracker {
  private process: ChildProcessWithoutNullStreams | null = null;
  private launch: { executable: string; args: string[] } | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempts = 0;
  private stopped = false;
  private startedAt = 0;
  mode: string | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly changed: (host: HostGeometry | null, ownForeground?: boolean) => void, private readonly failed: (message: string) => void) {}
  start(executable: string, overlayPid: number, mockHwnd?: string) {
    if (this.process || this.restartTimer) return true;
    if (!existsSync(executable)) { this.failed('窗口辅助组件缺失，请重新安装完整程序。'); return false; }
    const args = mockHwnd ? ['--mock-hwnd', mockHwnd, '--overlay-pid', String(overlayPid)] : ['--production', '--overlay-pid', String(overlayPid)];
    this.launch = { executable, args }; this.stopped = false; this.restartAttempts = 0;
    this.spawn();
    return true;
  }
  private rejectPending(message: string) {
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error(message)); }
    this.pending.clear();
  }
  private spawn() {
    if (this.stopped || !this.launch) return;
    const child = spawn(this.launch.executable, this.launch.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    this.startedAt = Date.now();
    this.mode = null;
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      if (this.process !== child || this.stopped) return;
      try {
        const value = JSON.parse(line);
        if (value.type === 'mode' && (value.mode === 'mock' || value.mode === 'production')) { this.mode = value.mode; this.failed(''); }
        if (value.type === 'host') this.changed(value.host, value.ownForeground === true);
        if (value.type === 'test-input') {
          const waiting = this.pending.get(value.id);
          if (waiting) { clearTimeout(waiting.timer); this.pending.delete(value.id); if (value.ok) waiting.resolve(value.payload); else waiting.reject(new Error('模拟宿主输入被拒绝：' + value.reason)); }
        }
      } catch { this.failed('窗口辅助组件返回无效状态。'); }
    });
    // error 后通常还会收到 exit。按当前子进程身份统一收尾，避免安排两次重启。
    const exited = () => {
      if (this.process !== child) return;
      const ready = this.mode !== null;
      this.process = null; this.mode = null; reader.close();
      this.rejectPending('窗口辅助组件已退出。');
      this.changed(null);
      if (this.stopped) return;
      // 稳定运行后才重置预算；不断崩溃的坏组件最多重试三次。
      if (ready && Date.now() - this.startedAt >= 10_000) this.restartAttempts = 0;
      const delays = [250, 1000, 3000];
      if (this.restartAttempts >= delays.length) { this.failed('窗口辅助组件反复退出，请重启小克或重新安装完整程序。'); return; }
      this.failed('窗口辅助组件已退出，正在自动重试。');
      this.restartTimer = setTimeout(() => { this.restartTimer = null; this.spawn(); }, delays[this.restartAttempts++]);
      this.restartTimer.unref();
    };
    child.on('error', exited);
    child.on('exit', exited);
    // 输入管道关闭可能单独报错；交给相同生命周期处理，避免未监听 error 终止主进程。
    child.stdin.on('error', () => { child.kill(); exited(); });
    // 原生错误输出不回显路径或其他进程信息。
    child.stderr.resume();
  }
  testInput(action: 'focus' | 'move' | 'click' | 'right-click' | 'style' | 'exit', point: { x: number; y: number }, hwnd?: string): Promise<unknown> {
    if (this.mode !== 'mock' || !this.process) return Promise.reject(new Error('输入验收只允许本项目模拟宿主。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('模拟输入超时。')); }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin.write(JSON.stringify({ id, action, x: Math.round(point.x), y: Math.round(point.y), hwnd }) + '\n');
    });
  }
  refresh() {
    const child = this.process;
    if (child && !child.killed && !child.stdin.destroyed && child.stdin.writable) child.stdin.write('refresh\n');
  }
  dispose() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.mode = null;
    this.rejectPending('窗口辅助组件已停止。');
    const child = this.process; this.process = null;
    if (child) { child.stdin.end('stop\n'); const timer = setTimeout(() => { if (!child.killed) child.kill(); }, 1500); timer.unref(); }
  }
}
