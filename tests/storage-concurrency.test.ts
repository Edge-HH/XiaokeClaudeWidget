import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SettingsStore, validateSource, type Cipher } from '../src/main/storage.js';

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

it('同一来源更换查询类型或站点须重新填写凭据，拒绝发送上个来源的密钥', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoke-credential-scope-'));
  const store = new SettingsStore(directory, cipher); await store.initialize();
  const original = { id: 'changing', kind: 'deepseek' as const, name: '余额' };
  await store.save(original, 'old-key');
  const replacement = { ...original, kind: 'newapi-token' as const, baseUrl: 'https://example.invalid' };
  await expect(store.save(replacement, '')).rejects.toThrow('重新填写');
  expect(store.secret(original.id)).toBe('old-key');
  expect(store.getPreferences().sources.find(source => source.id === original.id)?.kind).toBe('deepseek');
  expect(() => store.secret(original.id, replacement)).toThrow('重新填写');
  await store.save(replacement, 'new-key');
  expect(store.secret(original.id, replacement)).toBe('new-key');
  await expect(store.save({ ...replacement, baseUrl: 'https://other.invalid' }, '')).rejects.toThrow('重新填写');
  await expect(store.save({ ...replacement, baseUrl: 'https://example.invalid/Gateway' }, '')).rejects.toThrow('重新填写');
});
it('同站点规范化地址可以保留凭据，没有凭据的配置可直接更换类型', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoke-credential-equivalent-'));
  const store = new SettingsStore(directory, cipher); await store.initialize();
  const original = { id: 'same-site', kind: 'newapi-token' as const, name: '令牌', baseUrl: 'https://EXAMPLE.invalid:443/gateway/' };
  await store.save(original, 'same-key');
  const equivalent = { ...original, baseUrl: 'https://example.invalid/gateway///' };
  await store.save(equivalent, '');
  expect(store.secret(original.id, original)).toBe('same-key');
  await store.save({ id: 'empty', kind: 'deepseek', name: '未配置' });
  await store.save({ id: 'empty', kind: 'newapi-account', name: '未配置', baseUrl: 'https://example.invalid' }, '');
  expect(store.secret('empty')).toBe('');
});
it('保存并使用是一次完整修改，并发操作观察到各自对应的来源与凭据', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoke-save-activate-'));
  const store = new SettingsStore(directory, cipher); await store.initialize();
  const first = { id: 'first', kind: 'deepseek' as const, name: '一' };
  const second = { id: 'second', kind: 'deepseek' as const, name: '二' };
  const observations = await Promise.all([first, second].map(async source => {
    await store.saveAndActivate(source, source.id + '-key');
    return { activeId: store.getPreferences().activeId, secret: store.secret(source.id) };
  }));
  expect(observations).toEqual([{ activeId: 'first', secret: 'first-key' }, { activeId: 'second', secret: 'second-key' }]);
  const reopened = new SettingsStore(directory, cipher); await reopened.initialize();
  expect(reopened.getPreferences().activeId).toBe('second');
});
it('不存在或继承属性名称的来源不算已配置，也不读取任何凭据', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoke-credential-own-'));
  await writeFile(path.join(directory, 'credentials.json'), JSON.stringify({ orphan: Buffer.from('orphan-key').toString('base64') }));
  const store = new SettingsStore(directory, cipher); await store.initialize();
  expect(store.configured()).toEqual([]);
  for (const id of ['constructor', 'toString', '__proto__', 'orphan']) expect(store.secret(id)).toBe('');
  await store.save({ id: 'constructor', kind: 'deepseek', name: '自有属性' }, 'own-key');
  expect(store.secret('constructor')).toBe('own-key');
  expect(store.configured()).toEqual(['constructor']);
});
it('来源 ID 和凭据必须真的是字符串，不能靠运行时强制转换混入配置', async () => {
  expect(() => Reflect.apply(validateSource, undefined, [{ id: 123, kind: 'deepseek', name: '错误来源' }])).toThrow('来源');
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoke-credential-type-'));
  const store = new SettingsStore(directory, cipher); await store.initialize();
  await expect(Reflect.apply(store.save, store, [{ id: 'bad-key', kind: 'deepseek', name: '错误凭据' }, 123])).rejects.toThrow('凭据格式');
});
it('来源配置写入失败时回滚加密文件和内存密钥，原配置不被覆盖', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoke-storage-rollback-'));
  const store = new SettingsStore(directory, cipher); await store.initialize();
  const original = { id: 'source', kind: 'deepseek' as const, name: '原来源' };
  await store.saveAndActivate(original, 'old-key');
  const originalCredentials = await readFile(path.join(directory, 'credentials.json'), 'utf8');
  const originalPreferences = await readFile(path.join(directory, 'preferences.json'), 'utf8');
  // 只在一次性临时目录制造文件写入故障，先保留原配置，不删除目录或用户文件。
  await rename(path.join(directory, 'preferences.json'), path.join(directory, 'preferences-backup.json'));
  await mkdir(path.join(directory, 'preferences.json'));
  await expect(store.saveAndActivate({ ...original, kind: 'newapi-token', baseUrl: 'https://example.invalid' }, 'new-key')).rejects.toThrow();
  expect(store.secret(original.id)).toBe('old-key');
  expect(store.getPreferences().sources.find(source => source.id === original.id)).toEqual(original);
  expect(await readFile(path.join(directory, 'credentials.json'), 'utf8')).toBe(originalCredentials);
  expect(await readFile(path.join(directory, 'preferences-backup.json'), 'utf8')).toBe(originalPreferences);
});
