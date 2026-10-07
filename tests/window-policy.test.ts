import { it, expect } from 'vitest';
import { canShowPet } from '../src/main/window-policy.js';
import type { HostGeometry } from '../src/shared/types.js';
const host: HostGeometry = { hwnd:'mock', processId:1, x:0, y:0, width:800, height:600, dpi:96, visible:true, minimized:false, foreground:true };
it('前台、可见且未最小化才显示宠物；关闭与零客户区隐藏',()=>{
  expect(canShowPet(host)).toBe(true);
  expect(canShowPet({...host,foreground:false})).toBe(false);
  expect(canShowPet({...host,minimized:true})).toBe(false);
  expect(canShowPet({...host,visible:false})).toBe(false);
  expect(canShowPet({...host,width:0})).toBe(false);
  expect(canShowPet(null)).toBe(false);
});
it('测试前台信号也不能绕过宿主关闭和最小化',()=>{
  expect(canShowPet({...host,foreground:false},true)).toBe(true);
  expect(canShowPet({...host,minimized:true},true)).toBe(false);
  expect(canShowPet(host,false)).toBe(false);
});
