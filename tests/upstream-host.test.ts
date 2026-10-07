import { it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UpstreamHost } from '../src/main/upstream-host.js';

it('原版静音音效的 204 响应必须没有 body，不能导致本地协议抛错', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoke-local-protocol-'));
  const module = path.join(directory, 'fixture.mjs');
  await writeFile(module, `export default { apply(root) {
    root.inject([], ctx => ctx.webServer.register({
      kind: 'exact', path: '/dsh-xiaoke/muted.mp3',
      handler(req, res) { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); }
    }));
  } };`);
  const host = new UpstreamHost();
  try {
    await host.initialize(directory, directory, module);
    const response = await host.handle(new Request('xiaoke://app/dsh-xiaoke/muted.mp3'));
    expect(response.status).toBe(204);
    expect(response.body).toBe(null);
    expect(await response.text()).toBe('');
  } finally { host.dispose(); }
});
