import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { MockMaritimeClient } from '../../dev/mockClient';
import { AccessSession } from '../../services/accessSession';
import { RemoteVolume } from '../../filesystem/remoteVolume';
import { DirectoryCache } from '../../filesystem/directoryCache';
import type { FileList } from '../../api/types';

const id = 'mock-active';
const path = '/data/workspace/hello.txt';
const bytes = (value: string) => new TextEncoder().encode(value);
async function setup() {
  const client = new MockMaritimeClient();
  const access = new AccessSession(() => client);
  await access.open(id, async () => true);
  const volume = new RemoteVolume(
    () => client,
    access,
    () => true,
    async () => true,
  );
  client.calls.length = 0;
  return { client, access, volume };
}
describe('remote request budgets and cache safety', () => {
  it('saves a read nonempty file with three requests including a fresh byte comparison', async () => {
    const { client, volume } = await setup();
    await volume.readFile(id, path);
    client.calls.length = 0;
    await volume.writeFile(id, path, bytes('edited'), { create: true, overwrite: true });
    expect(client.calls).toEqual(['getAgent', 'download', 'upload']);
  });
  it.each([false, true])(
    'renames with three requests (overwrite=%s) while verifying the result',
    async (overwrite) => {
      const { client, volume } = await setup();
      await volume.rename(id, path, '/data/workspace/renamed.txt', overwrite);
      // Mock.move calls its own mkdir helper internally; it is not an SDK HTTP request.
      expect(client.calls.filter((name) => name !== 'mkdir')).toEqual([
        'getAgent',
        'move',
        'listFiles',
      ]);
    },
  );
  it('shares concurrent status checks and sibling metadata requests', async () => {
    const { client, volume } = await setup();
    await Promise.all([
      volume.stat(id, path),
      volume.stat(id, '/data/workspace/empty'),
      volume.readDirectory(id, '/data/workspace'),
    ]);
    expect(client.calls).toEqual(['getAgent', 'listFiles']);
  });
  it('reuses nearby metadata while checking agent status again', async () => {
    const { client, volume } = await setup();
    await volume.readDirectory(id, '/data/workspace');
    client.calls.length = 0;
    await volume.stat(id, path);
    expect(client.calls).toEqual(['getAgent']);
  });
  it('refuses an external edit even when Explorer metadata was cached', async () => {
    const { client, volume } = await setup();
    await volume.readFile(id, path);
    await volume.readDirectory(id, '/data/workspace');
    await client.upload(id, path, bytes('external edit'));
    await expect(
      volume.writeFile(id, path, bytes('my edit'), { create: true, overwrite: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await client.download(id, path)).toEqual(bytes('external edit'));
  });
  it('checks creation collisions against fresh metadata rather than a cached listing', async () => {
    const { client, volume } = await setup();
    const target = '/data/workspace/new.txt';
    await volume.readDirectory(id, '/data/workspace');
    await client.upload(id, target, bytes('created by another client'));
    await expect(
      volume.writeFile(id, target, bytes('mine'), { create: true, overwrite: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await client.download(id, target)).toEqual(bytes('created by another client'));
  });
  it('does not cache malformed remote directory entries', async () => {
    const { client, volume } = await setup();
    vi.spyOn(client, 'listFiles').mockResolvedValueOnce({
      root: '/data',
      path: '/data/workspace',
      entries: [{ name: '../outside', isDir: false, size: 0, mtime: 0 }],
    });
    await expect(volume.readDirectory(id, '/data/workspace')).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(volume.stat(id, path)).resolves.toMatchObject({ isDir: false });
  });
  it('does not use cached metadata to wake a sleeping agent', async () => {
    const { client, volume, access } = await setup();
    await volume.readDirectory(id, '/data/workspace');
    await client.lifecycle(id, 'sleep');
    client.calls.length = 0;
    await expect(volume.stat(id, path)).rejects.toMatchObject({ code: 'unavailable' });
    expect(client.calls).toEqual(['getAgent']);
    expect(access.root(id)).toBeUndefined();
    expect(client.agents[0]?.status).toBe('sleeping');
  });
  it('explicit refresh invalidates metadata without making a network request itself', async () => {
    const { client, volume } = await setup();
    await volume.readDirectory(id, '/data/workspace');
    await client.upload(id, '/data/workspace/new.txt', bytes('external'));
    client.calls.length = 0;
    volume.refresh(id);
    expect(client.calls).toEqual([]);
    expect(
      (await volume.readDirectory(id, '/data/workspace')).some((entry) => entry.name === 'new.txt'),
    ).toBe(true);
    expect(client.calls).toEqual(['getAgent', 'listFiles']);
  });
  it('invalidates metadata after a failed mutation with ambiguous remote effects', async () => {
    const { client, volume } = await setup();
    await volume.readFile(id, path);
    await volume.readDirectory(id, '/data/workspace');
    const upload = client.upload.bind(client);
    vi.spyOn(client, 'upload').mockImplementationOnce(async (id, path, content) => {
      await upload(id, path, content);
      throw new ApiError('timeout');
    });
    await expect(
      volume.writeFile(id, path, bytes('new remote bytes'), { create: true, overwrite: true }),
    ).rejects.toMatchObject({ code: 'timeout' });
    client.calls.length = 0;
    const entry = await volume.stat(id, path);
    expect(entry.size).toBe(bytes('new remote bytes').length);
    expect(client.calls).toEqual(['getAgent', 'listFiles']);
  });
  it('does not expose mutable cached entries to callers', async () => {
    const { volume } = await setup();
    const entries = await volume.readDirectory(id, '/data/workspace');
    entries[0]!.name = 'poisoned';
    expect(
      (await volume.readDirectory(id, '/data/workspace')).some(
        (entry) => entry.name === 'poisoned',
      ),
    ).toBe(false);
  });
  it('does not keep status failures for the next explicit operation', async () => {
    const { client, volume } = await setup();
    client.failNext = 'network';
    await expect(volume.stat(id, path)).rejects.toMatchObject({ code: 'network' });
    await expect(volume.stat(id, path)).resolves.toMatchObject({ isDir: false });
  });
});

describe('bounded short-lived directory metadata', () => {
  const listing: FileList = { root: '/data', path: '/data', entries: [] };
  it('expires by age without a background timer', async () => {
    let now = 0;
    const cache = new DirectoryCache(2000, 1024, () => now);
    const load = vi.fn(async () => listing);
    await cache.get('root', load);
    now = 1999;
    await cache.get('root', load);
    expect(load).toHaveBeenCalledTimes(1);
    now = 2000;
    await cache.get('root', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('does not refill the cache from a request invalidated during a write or refresh', async () => {
    const cache = new DirectoryCache();
    let release!: (value: FileList) => void;
    const pending = cache.get(
      'root',
      () =>
        new Promise<FileList>((resolve) => {
          release = resolve;
        }),
    );
    cache.clear();
    release(listing);
    await pending;
    const fresh = vi.fn(async () => listing);
    await cache.get('root', fresh);
    expect(fresh).toHaveBeenCalledTimes(1);
  });
  it('evicts old entries to respect its estimated byte budget', async () => {
    const cache = new DirectoryCache(2000, 256);
    const load = vi.fn(async () => listing);
    await cache.get('first', load);
    await cache.get('second', load);
    await cache.get('first', load);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('does not cache responses larger than its budget or failed requests', async () => {
    const cache = new DirectoryCache(2000, 1);
    const load = vi.fn(async () => listing);
    await cache.get('large', load);
    await cache.get('large', load);
    expect(load).toHaveBeenCalledTimes(2);
    await expect(
      cache.get('failed', async () => {
        throw new ApiError('network');
      }),
    ).rejects.toMatchObject({ code: 'network' });
    await expect(cache.get('failed', async () => listing)).resolves.toEqual(listing);
  });
});
