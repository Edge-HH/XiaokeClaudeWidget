import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { HostGeometry } from '../shared/types.js';

/** 原生组件只输出窗口元数据；演示模式只观察传入的本项目模拟窗口句柄。 */
export class WindowTracker {
  private process: ChildProcessWithoutNullStreams | null = null;
  mode: string | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly changed: (host: HostGeometry | null, ownForeground?: boolean) => void, private readonly failed: (message: string) => void) {}
  start(executable: string, overlayPid: number, mockHwnd?: string) {
    if (!existsSync(executable)) { this.failed('窗口辅助组件缺失，请重新安装完整程序。'); return false; }
    const args = mockHwnd ? ['--mock-hwnd', mockHwnd, '--overlay-pid', String(overlayPid)] : ['--production', '--overlay-pid', String(overlayPid)];
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      try {
        const value = JSON.parse(line);
        if (value.type === 'mode') this.mode = value.mode;
        if (value.type === 'host') this.changed(value.host, value.ownForeground === true);
        if (value.type === 'test-input') {
          const waiting = this.pending.get(value.id);
          if (waiting) { clearTimeout(waiting.timer); this.pending.delete(value.id); if (value.ok) waiting.resolve(value.payload); else waiting.reject(new Error('模拟宿主输入被拒绝：' + value.reason)); }
        }
      } catch { this.failed('窗口辅助组件返回无效状态。'); }
    });
    child.on('error', () => this.failed('窗口辅助组件无法启动。'));
    child.on('exit', code => { if (this.process === child) { this.process = null; this.changed(null); if (code) this.failed('窗口辅助组件已退出，请重启小克。'); } });
    // 原生错误输出不回显路径或其他进程信息。
    child.stderr.resume();
    return true;
  }
  testInput(action: 'focus' | 'move' | 'click' | 'right-click' | 'style', point: { x: number; y: number }, hwnd?: string): Promise<unknown> {
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
  dispose() { const child = this.process; this.process = null; if (child) { child.stdin.end('stop\n'); const timer = setTimeout(() => child.kill(), 1500); timer.unref(); } }
}
