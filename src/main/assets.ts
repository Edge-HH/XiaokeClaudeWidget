import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { AssetState } from '../shared/types.js';

export interface AssetEntry { name: string; gitSha: string; size: number; url: string }
export interface AssetManifest { commit: string; assets: AssetEntry[] }
export function gitBlobHash(bytes: Buffer): string { return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }
export class AssetManager {
  constructor(readonly root: string, readonly manifest: AssetManifest) {}
  async state(): Promise<AssetState> {
    const missing: string[] = [];
    for (const entry of this.manifest.assets) {
      try { const bytes = await readFile(path.join(this.root, 'assets', entry.name)); if (bytes.length !== entry.size || gitBlobHash(bytes) !== entry.gitSha) missing.push(entry.name); } catch { missing.push(entry.name); }
    }
    return { ready: missing.length === 0, missing, provenance: '原版素材不在 MIT 代码许可内；仅按原仓库说明提供用于运行，不授予新的素材权利。' };
  }
  async import(directory: string): Promise<AssetState> {
    const staged: Array<{ entry: AssetEntry; bytes: Buffer }> = [];
    // 先验证整组文件，避免错误目录造成一半原版、一半未知素材。
    for (const entry of this.manifest.assets) {
      let bytes: Buffer;
      try { bytes = await readFile(path.join(directory, entry.name)); } catch { throw new Error(`所选目录缺少原版素材 ${entry.name}。请选择固定版本插件的 assets 目录。`); }
      if (bytes.length !== entry.size || gitBlobHash(bytes) !== entry.gitSha) throw new Error(`素材 ${entry.name} 与固定原版版本不一致。`);
      staged.push({ entry, bytes });
    }
    await this.save(staged);
    return this.state();
  }
  async download(): Promise<AssetState> {
    const staged: Array<{ entry: AssetEntry; bytes: Buffer }> = [];
    for (const entry of this.manifest.assets) {
      // URL 只来自随代码固定的清单，不接受渲染页面传来的下载地址。
      if (!entry.url.startsWith(`https://raw.githubusercontent.com/aklnaaw/dsh-xiaoke-widget/${this.manifest.commit}/assets/`)) throw new Error('素材下载清单无效。');
      let response: Response;
      try { response = await fetch(entry.url, { redirect: 'error', signal: AbortSignal.timeout(30_000) }); } catch { throw new Error('无法连接原版素材仓库，请重试或选择本地导入。'); }
      if (!response.ok) throw new Error('原版素材下载失败，请重试或选择本地导入。');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== entry.size || gitBlobHash(bytes) !== entry.gitSha) throw new Error(`素材校验失败：${entry.name}。`);
      staged.push({ entry, bytes });
    }
    await this.save(staged);
    return this.state();
  }
  private async save(entries: Array<{ entry: AssetEntry; bytes: Buffer }>) {
    const directory = path.join(this.root, 'assets');
    await mkdir(directory, { recursive: true });
    for (const { entry, bytes } of entries) {
      const file = path.join(directory, entry.name);
      await writeFile(file + '.tmp', bytes); await rename(file + '.tmp', file);
    }
  }
}
