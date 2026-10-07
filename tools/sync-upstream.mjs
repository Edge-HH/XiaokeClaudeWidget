import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const commit = '4822bac4acc742ad91787495b9dd9ec32a38b1b7';
const base = `https://raw.githubusercontent.com/aklnaaw/dsh-xiaoke-widget/${commit}/`;
const root = path.resolve('vendor/upstream');
const files = ['lib/xiaoke-widget.js', 'lib/xiaoke-index.js', 'lib/accounting.mjs', 'LICENSE', 'PROVENANCE.md', 'upstream/PROVENANCE.upstream.md'];
if (process.argv.includes('--check')) {
  const manifest = JSON.parse(await readFile(path.join(root, 'source-manifest.json'), 'utf8'));
  for (const [file, hash] of Object.entries(manifest.files)) {
    const bytes = await readFile(path.join(root, file));
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`原版文件已改变：${file}`);
  }
  console.log('固定版本原版代码校验通过');
} else {
  const hashes = {};
  for (const file of files) {
    const response = await fetch(base + file);
    if (!response.ok) throw new Error(`下载失败：${file}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), bytes);
    hashes[file] = createHash('sha256').update(bytes).digest('hex');
  }
  await writeFile(path.join(root, 'source-manifest.json'), JSON.stringify({ repository: 'aklnaaw/dsh-xiaoke-widget', commit, files: hashes }, null, 2));
  // 这里只记录字节校验，不保存或再分发上游素材。
  const treeResponse = await fetch(`https://api.github.com/repos/aklnaaw/dsh-xiaoke-widget/git/trees/${commit}?recursive=1`);
  if (!treeResponse.ok) throw new Error('无法读取原版素材清单');
  const tree = await treeResponse.json();
  const assets = tree.tree.filter(item => item.type === 'blob' && item.path.startsWith('assets/')).map(item => ({ name: item.path.slice(7), gitSha: item.sha, size: item.size, url: base + item.path }));
  await writeFile(path.join(root, 'asset-manifest.json'), JSON.stringify({ commit, assets }, null, 2));
  console.log('已固定原版代码和素材清单；未下载素材');
}
