import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SettingsStore, validateSource, type Cipher } from '../src/main/storage.js';
import { AssetManager, gitBlobHash } from '../src/main/assets.js';
const key = randomBytes(32);
// 测试 cipher 只用于验证存储边界；生产始终使用 Windows safeStorage。
const cipher: Cipher = {
  isEncryptionAvailable: () => true,
  encryptString(value) { const iv = randomBytes(12); const encryptor = createCipheriv('aes-256-gcm', key, iv); const content = Buffer.concat([encryptor.update(value, 'utf8'), encryptor.final()]); return Buffer.concat([iv, encryptor.getAuthTag(), content]); },
  decryptString(bytes) { const decryptor = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decryptor.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decryptor.update(bytes.subarray(28)), decryptor.final()]).toString('utf8'); },
};
it('配置重启后保留，已保存密钥不进入公共配置，删除时移除凭据', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'xiaoke-storage-'));
  const store = new SettingsStore(dir, cipher); await store.initialize();
  await store.save({ id: 'deepseek-test', kind: 'deepseek', name: '测试来源' }, 'private-mock-secret'); await store.activate('deepseek-test');
  expect(await readFile(path.join(dir, 'preferences.json'), 'utf8')).not.toContain('private-mock-secret');
  expect(await readFile(path.join(dir, 'credentials.json'), 'utf8')).not.toContain('private-mock-secret');
  const reopened = new SettingsStore(dir, cipher); await reopened.initialize();
  expect(reopened.secret('deepseek-test')).toBe('private-mock-secret'); expect(reopened.getPreferences().activeId).toBe('deepseek-test');
  await reopened.remove('deepseek-test'); expect(reopened.configured()).not.toContain('deepseek-test');
});
it('加密不可用时拒绝保存，损坏配置不被空配置覆盖', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'xiaoke-corrupt-'));
  const store = new SettingsStore(dir, { ...cipher, isEncryptionAvailable: () => false }); await store.initialize();
  await expect(store.save({ id: 'secret', name: '来源', kind: 'deepseek' }, 'mock')).rejects.toThrow('加密不可用');
  await writeFile(path.join(dir, 'preferences.json'), 'broken');
  await expect(new SettingsStore(dir, cipher).initialize()).rejects.toThrow('损坏');
  expect(await readFile(path.join(dir, 'preferences.json'), 'utf8')).toBe('broken');
  expect(() => validateSource({ id: '../escape', name: '来源', kind: 'claude' })).toThrow();
});
it('离线导入原版素材先校验整组字节，缺失时仍能打开配置', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'xiaoke-assets-')); const input = path.join(dir, 'input'); await mkdir(input);
  const bytes = Buffer.from('mock-asset-only');
  const manager = new AssetManager(path.join(dir, 'cache'), { commit: 'mock', assets: [{ name: 'mock.png', gitSha: gitBlobHash(bytes), size: bytes.length, url: 'invalid' }] });
  expect(await manager.state()).toMatchObject({ ready: false, missing: ['mock.png'] });
  await writeFile(path.join(input, 'mock.png'), 'bad'); await expect(manager.import(input)).rejects.toThrow('不一致');
  await writeFile(path.join(input, 'mock.png'), bytes); expect(await manager.import(input)).toMatchObject({ ready: true });
});
