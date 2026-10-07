import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Preferences, SourceConfig } from '../shared/types.js';

export interface Cipher { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
export const defaultPreferences = (): Preferences => ({ version: 1, activeId: 'claude-default', sources: [{ id: 'claude-default', name: 'Claude', kind: 'claude' }] });

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  // 不同写入使用独立临时文件；失败时也不遗留明文或加密凭据碎片。
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}
export function validateSource(input: SourceConfig): SourceConfig {
  const kinds = ['claude', 'deepseek', 'newapi-token', 'newapi-account'];
  if (!input || !/^[\w-]{1,80}$/.test(input.id) || !kinds.includes(input.kind) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new Error('查询来源名称或类型无效。');
  const config: SourceConfig = { id: input.id, kind: input.kind, name: input.name.trim() };
  for (const field of ['baseUrl', 'organizationId', 'userId', 'currency'] as const) {
    if (input[field] !== undefined) {
      if (typeof input[field] !== 'string' || input[field]!.length > 500 || /[\r\n]/.test(input[field]!)) throw new Error('查询配置包含无效文本。');
      config[field] = input[field]!.trim();
    }
  }
  for (const field of ['quotaPerUnit', 'currencyRate'] as const) {
    if (input[field] !== undefined) {
      if (!Number.isFinite(input[field]) || input[field]! <= 0) throw new Error('额度换算参数必须大于零。');
      config[field] = input[field];
    }
  }
  return config;
}
export class SettingsStore {
  private preferences: Preferences = defaultPreferences();
  private secrets: Record<string, string> = {};
  private readonly secretFile: string;
  private readonly configFile: string;
  private pendingMutation: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string, private readonly cipher: Cipher) {
    this.secretFile = path.join(directory, 'credentials.json');
    this.configFile = path.join(directory, 'preferences.json');
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.configFile, 'utf8'));
      if (raw.version !== 1 || !Array.isArray(raw.sources) || !raw.sources.length) throw new Error('配置版本无效。');
      const sources: SourceConfig[] = raw.sources.map(validateSource);
      if (new Set(sources.map(source => source.id)).size !== sources.length) throw new Error('查询来源 ID 重复。');
      if (!sources.some(source => source.id === raw.activeId)) throw new Error('当前查询来源不存在。');
      this.preferences = { version: 1, activeId: raw.activeId, sources };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('配置文件损坏，已暂停保存，请检查 preferences.json。'); }
    try {
      const secrets: unknown = JSON.parse(await readFile(this.secretFile, 'utf8'));
      if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets) ||
          Object.entries(secrets).some(([id, value]) => !/^[\w-]{1,80}$/.test(id) || typeof value !== 'string' || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))) {
        throw new Error('凭据结构无效。');
      }
      this.secrets = secrets as Record<string, string>;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('凭据文件损坏，已暂停保存。'); }
  }
  getPreferences(): Preferences { return structuredClone(this.preferences); }
  configured(): string[] { return Object.keys(this.secrets); }
  secret(id: string): string {
    if (!this.secrets[id]) return '';
    try { return this.cipher.decryptString(Buffer.from(this.secrets[id], 'base64')); } catch { throw new Error('无法解密凭据，请在当前 Windows 账户中重新配置。'); }
  }
  // IPC 可能同时来自宠物和设置；串行执行整次修改，避免旧内存快照覆盖较新的来源。
  private mutate(operation: () => Promise<void>): Promise<void> {
    const work = this.pendingMutation.then(operation);
    this.pendingMutation = work.catch(() => {});
    return work;
  }
  save(source: SourceConfig, secret?: string): Promise<void> {
    const config = validateSource(source);
    return this.mutate(() => this.saveNow(config, secret));
  }
  private async saveNow(config: SourceConfig, secret?: string): Promise<void> {
    if (secret !== undefined && secret !== '') {
      if (secret.length > 8192 || /[\r\n]/.test(secret)) throw new Error('凭据格式无效。');
      if (!this.cipher.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用，未保存密钥。');
      const next = { ...this.secrets, [config.id]: this.cipher.encryptString(secret).toString('base64') };
      await atomicJson(this.secretFile, next);
      this.secrets = next;
    }
    const next = this.getPreferences();
    const index = next.sources.findIndex(row => row.id === config.id);
    if (index >= 0) next.sources[index] = config; else next.sources.push(config);
    await atomicJson(this.configFile, next);
    this.preferences = next;
  }
  activate(id: string): Promise<void> { return this.mutate(() => this.activateNow(id)); }
  private async activateNow(id: string) {
    if (!this.preferences.sources.some(source => source.id === id)) throw new Error('查询来源不存在。');
    const next = { ...this.preferences, activeId: id };
    await atomicJson(this.configFile, next);
    this.preferences = next;
  }
  remove(id: string): Promise<void> { return this.mutate(() => this.removeNow(id)); }
  private async removeNow(id: string) {
    const next = this.getPreferences();
    next.sources = next.sources.filter(source => source.id !== id);
    if (!next.sources.length) next.sources = defaultPreferences().sources;
    if (!next.sources.some(source => source.id === next.activeId)) next.activeId = next.sources[0].id;
    const secrets = { ...this.secrets }; delete secrets[id];
    await atomicJson(this.secretFile, secrets);
    await atomicJson(this.configFile, next);
    this.secrets = secrets; this.preferences = next;
  }
}
