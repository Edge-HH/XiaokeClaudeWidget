import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
const roots = ['dist/main', 'dist/shared', 'dist/renderer', 'dist/vendor'];
const forbidden = /\.(?:png|jpe?g|gif|webp|mp3|wav|ogg)$/i;
async function scan(directory) {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name); const info = await stat(file);
    if (info.isDirectory()) await scan(file);
    else if (forbidden.test(name) || /credentials|preferences|\.test-artifacts/.test(file)) throw new Error(`禁止打包受限素材或用户数据：${file}`);
  }
}
for (const root of roots) await scan(root);
const native = await stat('dist/native/WindowBridge.exe');
if (!native.isFile() || native.size < 1_000_000) throw new Error('自包含 Windows 辅助组件缺失。');
await readFile('LICENSE'); await readFile('NOTICE.md');
console.log('交付检查通过：无原版图片、音效、用户配置或密钥');
