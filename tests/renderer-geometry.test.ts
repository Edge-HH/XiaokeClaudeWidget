import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const bridge = readFileSync(new URL('../src/renderer/widget-bridge.js', import.meta.url), 'utf8');
const upstream = readFileSync(new URL('../vendor/upstream/lib/xiaoke-widget.js', import.meta.url), 'utf8');
const tree = ts.createSourceFile('upstream.js', upstream, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let originalPositionMenu = '';
function find(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'positionMenu') originalPositionMenu = upstream.slice(node.getStart(tree), node.end);
  ts.forEachChild(node, find);
}
find(tree);
if (!originalPositionMenu) throw new Error('固定原版缺少菜单定位入口');

function harness(width: number, height: number, rootTop: number) {
  const style: Record<string, string> = {};
  const menu = {
    style,
    get offsetWidth() { return Math.min(340, Number.parseFloat(style.maxWidth) || 340); },
    get offsetHeight() { return Math.min(640, Number.parseFloat(style.maxHeight) || 640); },
    getBoundingClientRect() {
      const w = this.offsetWidth, h = this.offsetHeight;
      const left = style.left && style.left !== 'auto' ? Number.parseFloat(style.left) : width - Number.parseFloat(style.right) - w;
      const top = style.top && style.top !== 'auto' ? Number.parseFloat(style.top) : height - Number.parseFloat(style.bottom) - h;
      return { left, top, right: left + w, bottom: top + h, width: w, height: h };
    },
  };
  const context = vm.createContext({
    root: { getBoundingClientRect: () => ({ left: width - 300, top: rootTop, right: width, bottom: rootTop + 300, width: 300, height: 300 }) },
    menuBtn: { getBoundingClientRect: () => ({ left: width - 34, right: width - 8 }) },
    menuBox: menu, viewport: () => ({ w: width, h: height }),
  });
  vm.runInContext(originalPositionMenu + '\n' + bridge, context);
  return { menu, place: () => vm.runInContext('typeof desktopPositionMenu === "function" ? desktopPositionMenu() : positionMenu()', context) };
}

describe('主菜单在宿主客户区内可操作', () => {
  it('宠物拖到顶部后主菜单仍完整位于视口内', () => {
    const ui = harness(900, 900, 0);
    ui.place();
    expect(ui.menu.getBoundingClientRect().top).toBeGreaterThanOrEqual(8);
    expect(ui.menu.getBoundingClientRect().bottom).toBeLessThanOrEqual(892);
  });

  it('小宿主窗口限制菜单高度并允许滚动，查询来源按钮仍可到达', () => {
    const ui = harness(620, 240, 0);
    ui.place();
    expect(ui.menu.offsetHeight).toBeLessThanOrEqual(224);
    expect(ui.menu.style.overflowY).toBe('auto');
    expect(ui.menu.getBoundingClientRect().top).toBeGreaterThanOrEqual(8);
    expect(ui.menu.getBoundingClientRect().bottom).toBeLessThanOrEqual(232);
  });

  it('狭窄宿主窗口内菜单左右边界都可见', () => {
    const ui = harness(280, 700, 380);
    ui.place();
    const rect = ui.menu.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(8);
    expect(rect.right).toBeLessThanOrEqual(272);
  });
});
