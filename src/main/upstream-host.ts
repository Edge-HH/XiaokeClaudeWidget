import { Readable } from 'node:stream';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

interface Route { kind: string; path: string; handler: (request: unknown, response: unknown) => unknown }
/** 原版宿主 API 的本进程适配；没有监听 TCP，也没有创建 DSH 或调用 DSH CLI。 */
export class UpstreamHost {
  private routes: Route[] = [];
  private disposers: Array<() => void> = [];
  async initialize(directory: string, assetsRoot: string, moduleFile: string) {
    await mkdir(directory, { recursive: true });
    process.env.XIAOKE_DATA_HOME = directory;
    process.env.XIAOKE_ASSET_ROOT = assetsRoot;
    const context = {
      webServer: {
        register: (route: Route) => { this.routes.push(route); return () => { this.routes = this.routes.filter(row => row !== route); }; },
        tapIndex: () => () => {},
      },
      // 原版凭据查询、外部探活和其他来源被停用，统一由新的 UsageProvider 承接。
      credentials: { resolve: async () => null, set: async () => { throw new Error('请通过查询来源设置保存凭据。'); } },
      connection: { requestRejection: () => null },
      get: (name: string): unknown => name === 'connection' ? context.connection : null,
      on: () => () => {},
      effect: (factory: () => () => void) => { this.disposers.push(factory()); },
    };
    const root = { on: () => () => {}, effect: context.effect, inject: (_services: string[], callback: (ctx: typeof context) => void) => callback(context) };
    const plugin = (await import(pathToFileURL(path.resolve(moduleFile)).href)).default;
    plugin.apply(root);
  }
  async handle(input: Request): Promise<Response> {
    const url = new URL(input.url);
    const route = this.routes.find(row => row.kind === 'prefix' ? url.pathname.startsWith(row.path) : url.pathname === row.path);
    if (!route) return new Response('没有此本地接口', { status: 404 });
    const body = Buffer.from(await input.arrayBuffer());
    const request = Object.assign(Readable.from([body]), {
      url: url.pathname + url.search,
      method: input.method,
      headers: { ...Object.fromEntries(input.headers), host: 'localhost', origin: 'http://localhost', 'sec-fetch-site': 'same-origin' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    let status = 200;
    let headers: Record<string, string> = {};
    const chunks: Buffer[] = [];
    let ended = false;
    const response = {
      get statusCode() { return status; }, set statusCode(value: number) { status = value; },
      writeHead: (code: number, values: Record<string, unknown> = {}) => { status = code; headers = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])); },
      setHeader: (name: string, value: string) => { headers[name] = value; },
      write: (bytes: string | Buffer) => { chunks.push(Buffer.from(bytes)); },
      end: (bytes?: string | Buffer) => { if (bytes !== undefined) chunks.push(Buffer.from(bytes)); ended = true; },
    };
    try { await route.handler(request, response); } catch { return new Response('原版设置接口处理失败', { status: 500 }); }
    if (!ended) return new Response('原版接口未完成响应', { status: 500 });
    return new Response(new Uint8Array(Buffer.concat(chunks)), { status, headers });
  }
  dispose() { for (const dispose of this.disposers) dispose(); this.routes = []; }
}
