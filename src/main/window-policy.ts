import type { HostGeometry } from '../shared/types.js';

export function canShowPet(host: HostGeometry | null, foregroundFixture: boolean | null = null, ownForeground = false): boolean {
  // 设置/输入编辑属于小克自身，允许继续贴附；其他程序在前台仍立即隐藏。
  return !!host && host.visible && !host.minimized && host.width > 0 && host.height > 0 && (foregroundFixture ?? (host.foreground || ownForeground));
}
