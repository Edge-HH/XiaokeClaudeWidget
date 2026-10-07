import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SettingsStore, type Cipher } from '../src/main/storage.js';

// 仅使用假凭据验证文件操作，不接触系统凭据或任何服务。
const cipher: Cipher = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value),
  decryptString: value => value.toString(),
};

it('同时保存多个来源不会互相覆盖，也不会争用同一个临时文件', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoke-concurrent-'));
  const store = new SettingsStore(directory, cipher);
  await store.initialize();
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    store.save({ id: 'source-' + index, kind: 'deepseek', name: '来源 ' + index }, 'mock-key-' + index)));
  expect(results.map(result => result.status)).toEqual(Array(8).fill('fulfilled'));
  const reopened = new SettingsStore(directory, cipher);
  await reopened.initialize();
  for (let index = 0; index < 8; index++) {
    expect(reopened.getPreferences().sources.some(source => source.id === 'source-' + index)).toBe(true);
    expect(reopened.secret('source-' + index)).toBe('mock-key-' + index);
  }
});

it('损坏但合法 JSON 的凭据不能被当成可用配置', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoke-credential-shape-'));
  for (const value of [null, [], { source: 123 }, { source: '' }]) {
    await writeFile(path.join(directory, 'credentials.json'), JSON.stringify(value));
    await expect(new SettingsStore(directory, cipher).initialize()).rejects.toThrow('凭据文件损坏');
    expect(JSON.parse(await readFile(path.join(directory, 'credentials.json'), 'utf8'))).toEqual(value);
  }
});

it('同名 ID 的重复来源配置必须明确报错，避免查询来源串号', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoke-duplicate-source-'));
  await writeFile(path.join(directory, 'preferences.json'), JSON.stringify({
    version: 1, activeId: 'duplicate', sources: [
      { id: 'duplicate', kind: 'deepseek', name: '来源一' },
      { id: 'duplicate', kind: 'newapi-token', name: '来源二', baseUrl: 'https://example.invalid' },
    ],
  }));
  await expect(new SettingsStore(directory, cipher).initialize()).rejects.toThrow('配置文件损坏');
});
