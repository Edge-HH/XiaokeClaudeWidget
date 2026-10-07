import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Preferences, SourceConfig } from '../shared/types.js';

export interface Cipher { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
export const defaultPreferences = (): Preferences => ({ version: 1, activeId: 'claude-default', sources: [{ id: 'claude-default', name: 'Claude', kind: 'claude' }] });

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
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
      if (!sources.some(source => source.id === raw.activeId)) throw new Error('当前查询来源不存在。');
      this.preferences = { version: 1, activeId: raw.activeId, sources };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('配置文件损坏，已暂停保存，请检查 preferences.json。'); }
    try { this.secrets = JSON.parse(await readFile(this.secretFile, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('凭据文件损坏，已暂停保存。'); }
  }
  getPreferences(): Preferences { return structuredClone(this.preferences); }
  configured(): string[] { return Object.keys(this.secrets); }
  secret(id: string): string {
    if (!this.secrets[id]) return '';
    try { return this.cipher.decryptString(Buffer.from(this.secrets[id], 'base64')); } catch { throw new Error('无法解密凭据，请在当前 Windows 账户中重新配置。'); }
  }
  async save(source: SourceConfig, secret?: string): Promise<void> {
    const config = validateSource(source);
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
  async activate(id: string) {
    if (!this.preferences.sources.some(source => source.id === id)) throw new Error('查询来源不存在。');
    const next = { ...this.preferences, activeId: id };
    await atomicJson(this.configFile, next);
    this.preferences = next;
  }
  async remove(id: string) {
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
