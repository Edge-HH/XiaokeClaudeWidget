import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { WindowTracker } from '../src/main/window-tracker.js';

vi.mock('node:fs', () => ({ existsSync: () => true }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const children: Array<ReturnType<typeof child>> = [];
let tracker: WindowTracker;
const changed = vi.fn();
const failed = vi.fn();
function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    killed: false, kill: vi.fn(),
  });
}
function send(process: ReturnType<typeof child>, value: unknown) { process.stdout.write(JSON.stringify(value) + '\n'); }
beforeEach(() => {
  vi.useFakeTimers(); children.length = 0; changed.mockReset(); failed.mockReset();
  vi.mocked(spawn).mockImplementation(() => { const process = child(); children.push(process); return process as never; });
  tracker = new WindowTracker(changed, failed);
});
afterEach(() => { tracker.dispose(); vi.useRealTimers(); });

it('辅助组件意外正常退出也应报告故障并自动重启，恢复后清除故障', async () => {
  tracker.start('offline-helper', 123, '456');
  send(children[0], { type: 'mode', mode: 'mock' });
  children[0].emit('exit', 0);
  expect(changed).toHaveBeenLastCalledWith(null);
  expect(failed).toHaveBeenLastCalledWith(expect.stringContaining('重试'));
  expect(tracker.mode).toBe(null);
  await vi.advanceTimersByTimeAsync(300);
  expect(children).toHaveLength(2);
  send(children[1], { type: 'mode', mode: 'mock' });
  expect(failed).toHaveBeenLastCalledWith('');
  expect(tracker.mode).toBe('mock');
});
it('启动故障仅重试有限次数，error和exit同时到达不会重复重启', async () => {
  tracker.start('offline-helper', 123, '456');
  for (let index = 0; index < 4; index++) {
    children[index].emit('error', new Error('模拟启动失败'));
    children[index].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(4_000);
  }
  expect(children).toHaveLength(4);
  expect(failed).toHaveBeenLastCalledWith(expect.stringContaining('请重启'));
});
it('组件退出立即终结待处理的模拟输入，旧进程消息不能恢复宿主', async () => {
  tracker.start('offline-helper', 123, '456');
  send(children[0], { type: 'mode', mode: 'mock' });
  const pending = tracker.testInput('focus', { x: 0, y: 0 });
  const rejected = expect(pending).rejects.toThrow('退出');
  children[0].emit('exit', 1);
  await rejected;
  changed.mockClear();
  send(children[0], { type: 'host', host: { hwnd: 'obsolete' } });
  expect(changed).not.toHaveBeenCalled();
});
it('主动退出取消重启，也立即取消尚未完成的模拟输入', async () => {
  tracker.start('offline-helper', 123, '456');
  send(children[0], { type: 'mode', mode: 'mock' });
  const pending = tracker.testInput('focus', { x: 0, y: 0 });
  const rejected = expect(pending).rejects.toThrow('停止');
  tracker.dispose(); await rejected;
  children[0].emit('exit', 0);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(children).toHaveLength(1);
  expect(tracker.mode).toBe(null);
});
it('尚未报告模式的长时间启动失败不能反复重置重试预算', async () => {
  tracker.start('offline-helper', 123, '456');
  for (let index = 0; index < 4; index++) {
    await vi.advanceTimersByTimeAsync(11_000);
    children[index].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(4_000);
  }
  expect(children).toHaveLength(4);
  expect(failed).toHaveBeenLastCalledWith(expect.stringContaining('请重启'));
});
it('已报告模式并稳定运行后，再次退出获得新的恢复预算', async () => {
  tracker.start('offline-helper', 123, '456');
  for (let index = 0; index < 3; index++) {
    children[index].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(4_000);
  }
  send(children[3], { type: 'mode', mode: 'mock' });
  await vi.advanceTimersByTimeAsync(11_000);
  children[3].emit('exit', 1);
  await vi.advanceTimersByTimeAsync(300);
  expect(children).toHaveLength(5);
});
