import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { MockMaritimeClient } from '../../dev/mockClient';
import { AccessSession } from '../../services/accessSession';
import { RemoteVolume } from '../../filesystem/remoteVolume';
import { FileCache, fingerprint } from '../../filesystem/fileCache';
import { MAX_FILE_BYTES } from '../../api/types';
const id = 'mock-active';
const path = '/data/workspace/hello.txt';
const bytes = (s: string) => new TextEncoder().encode(s);
async function setup(allowed = true, trusted = true) {
  const client = new MockMaritimeClient();
  const access = new AccessSession(() => client);
  await access.open(id, async () => true);
  const confirm = vi.fn(async () => allowed);
  const changes = vi.fn();
  const fs = new RemoteVolume(
    () => client,
    access,
    () => trusted,
    confirm,
    changes,
  );
  return { client, access, fs, confirm, changes };
}
describe('remote filesystem', () => {
  it('browses, reads, edits and persists byte content', async () => {
    const { fs } = await setup();
    expect((await fs.readDirectory(id, '/data/workspace')).map((e) => e.name)).toContain(
      'hello.txt',
    );
    expect((await fs.stat(id, path)).isDir).toBe(false);
    await fs.readFile(id, path);
    const content = new Uint8Array([0, 255, 128, 1]);
    await fs.writeFile(id, path, content, { create: true, overwrite: true });
    expect(await fs.readFile(id, path)).toEqual(content);
  });
  it('handles empty files', async () => {
    const { fs } = await setup();
    expect(await fs.readFile(id, '/data/workspace/empty')).toEqual(new Uint8Array());
    await fs.writeFile(id, '/data/new', new Uint8Array(), { create: true, overwrite: false });
    expect(await fs.readFile(id, '/data/new')).toEqual(new Uint8Array());
  });
  it('creates, renames and deletes with explicit confirmation', async () => {
    const { fs, confirm, changes } = await setup();
    await fs.createDirectory(id, '/data/new');
    await fs.writeFile(id, '/data/new/a', bytes('test'), { create: true, overwrite: false });
    await fs.rename(id, '/data/new/a', '/data/new/b', false);
    expect(await fs.readFile(id, '/data/new/b')).toEqual(bytes('test'));
    await fs.delete(id, '/data/new/b', false);
    expect(confirm).toHaveBeenCalledWith(id, '/data/new/b');
    await expect(fs.stat(id, '/data/new/b')).rejects.toMatchObject({ code: 'missing' });
    expect(changes).toHaveBeenCalled();
  });
  it('refuses delete when confirmation is declined', async () => {
    const { fs, client } = await setup(false);
    await expect(fs.delete(id, path, false)).rejects.toMatchObject({ code: 'cancelled' });
    expect(client.calls).not.toContain('delete');
    expect(await fs.readFile(id, path)).toBeDefined();
  });
  it('refuses the volume root and non-recursive nonempty directories', async () => {
    const { fs } = await setup();
    await expect(fs.delete(id, '/data', true)).rejects.toMatchObject({ code: 'permission' });
    await expect(fs.delete(id, '/data/workspace', false)).rejects.toMatchObject({
      code: 'permission',
    });
    await expect(fs.rename(id, '/data', '/data/moved', false)).rejects.toMatchObject({
      code: 'permission',
    });
  });
  it('detects concurrent edits with identical metadata size', async () => {
    const { fs, client } = await setup();
    const original = await fs.readFile(id, path);
    await client.upload(id, path, new Uint8Array(original.length).fill(65));
    await expect(
      fs.writeFile(id, path, bytes('mine'), { create: true, overwrite: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await client.download(id, path)).not.toEqual(bytes('mine'));
  });
  it('refuses overwriting an unread file', async () => {
    const { fs } = await setup();
    await expect(
      fs.writeFile(id, path, bytes('mine'), { create: true, overwrite: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('refuses resurrecting a file deleted after it was read', async () => {
    const { fs, client } = await setup();
    await fs.readFile(id, path);
    await client.delete(id, path);
    await expect(
      fs.writeFile(id, path, bytes('mine'), { create: true, overwrite: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('refuses a delayed save to the old URI after a rename', async () => {
    const { fs, client } = await setup();
    const original = await fs.readFile(id, path);
    const target = '/data/workspace/renamed.txt';
    await fs.rename(id, path, target, false);
    await expect(
      fs.writeFile(id, path, bytes('stale editor save'), { create: true, overwrite: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(client.download(id, path)).rejects.toMatchObject({ code: 'missing' });
    expect(await client.download(id, target)).toEqual(original);
  });
  it('preserves read baselines at the renamed URI for dirty document saves', async () => {
    const { fs, client } = await setup();
    await fs.readFile(id, path);
    const target = '/data/workspace/renamed.txt';
    await fs.rename(id, path, target, false);
    await fs.writeFile(id, target, bytes('edited after rename'), { create: true, overwrite: true });
    expect(await client.download(id, target)).toEqual(bytes('edited after rename'));
    await expect(client.download(id, path)).rejects.toMatchObject({ code: 'missing' });
  });
  it('protects descendants of a renamed directory from delayed saves', async () => {
    const { fs, client } = await setup();
    await fs.readFile(id, path);
    await fs.rename(id, '/data/workspace', '/data/moved', false);
    await expect(
      fs.writeFile(id, path, bytes('stale'), { create: true, overwrite: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await fs.writeFile(id, '/data/moved/hello.txt', bytes('edited'), {
      create: true,
      overwrite: true,
    });
    expect(await client.download(id, '/data/moved/hello.txt')).toEqual(bytes('edited'));
  });
  it('allows explicitly creating a new file at a retired name without overwrite', async () => {
    const { fs } = await setup();
    await fs.readFile(id, path);
    await fs.rename(id, path, '/data/workspace/renamed.txt', false);
    await fs.writeFile(id, path, bytes('intentional new file'), { create: true, overwrite: false });
    expect(await fs.readFile(id, path)).toEqual(bytes('intentional new file'));
  });
  it('still refuses external content changes after moving a read baseline', async () => {
    const { fs, client } = await setup();
    await fs.readFile(id, path);
    const target = '/data/workspace/renamed.txt';
    await fs.rename(id, path, target, false);
    await client.upload(id, target, bytes('external'));
    await expect(
      fs.writeFile(id, target, bytes('mine'), { create: true, overwrite: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await client.download(id, target)).toEqual(bytes('external'));
  });
  it('does not report a copy as a successful rename or delete the source to fix it', async () => {
    const { fs, client, changes } = await setup();
    vi.spyOn(client, 'move').mockImplementation(async (id, from, to) => {
      await client.upload(id, to, await client.download(id, from));
    });
    await expect(fs.rename(id, path, '/data/workspace/copied.txt', false)).rejects.toMatchObject({
      code: 'moveIncomplete',
    });
    expect(client.calls).not.toContain('delete');
    expect(changes).not.toHaveBeenCalled();
  });
  it('refuses delayed saves after a confirmed delete', async () => {
    const { fs, client } = await setup();
    await fs.readFile(id, path);
    await fs.delete(id, path, false);
    await expect(
      fs.writeFile(id, path, bytes('stale'), { create: true, overwrite: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(client.download(id, path)).rejects.toMatchObject({ code: 'missing' });
  });
  it('honors create and overwrite flags', async () => {
    const { fs } = await setup();
    await expect(
      fs.writeFile(id, '/data/missing', bytes('x'), { create: false, overwrite: true }),
    ).rejects.toMatchObject({ code: 'missing' });
    await expect(
      fs.writeFile(id, path, bytes('x'), { create: true, overwrite: false }),
    ).rejects.toMatchObject({ code: 'exists' });
  });
  it('does not delete existing rename destinations even with overwrite requested', async () => {
    const { fs, client } = await setup();
    await expect(fs.rename(id, path, '/data/workspace/empty', true)).rejects.toMatchObject({
      code: 'exists',
    });
    expect(client.calls).not.toContain('delete');
    await expect(fs.rename(id, path, '/data/workspace/empty', false)).rejects.toMatchObject({
      code: 'exists',
    });
  });
  it.each(['network', 'timeout', 'permission', 'rateLimit'] as const)(
    'propagates %s without recording success',
    async (code) => {
      const { fs, client, changes } = await setup();
      await fs.readFile(id, path);
      client.failNext = code;
      await expect(
        fs.writeFile(id, path, bytes('x'), { create: true, overwrite: true }),
      ).rejects.toMatchObject({ code });
      expect(changes).not.toHaveBeenCalled();
    },
  );
  it('blocks all mutations in untrusted workspaces', async () => {
    const { fs, client } = await setup(true, false);
    await expect(
      fs.writeFile(id, path, bytes('x'), { create: true, overwrite: true }),
    ).rejects.toMatchObject({ code: 'permission' });
    await expect(fs.delete(id, path, false)).rejects.toMatchObject({ code: 'permission' });
    expect(client.calls).not.toContain('upload');
  });
  it('rejects oversized data before upload', async () => {
    const { fs, client } = await setup();
    await expect(
      fs.writeFile(id, '/data/large', new Uint8Array(MAX_FILE_BYTES + 1), {
        create: true,
        overwrite: false,
      }),
    ).rejects.toMatchObject({ code: 'tooLarge' });
    expect(client.calls).not.toContain('upload');
  });
  it('blocks restored sessions and sleeping agents without file requests', async () => {
    const { fs, client, access } = await setup();
    access.clear();
    client.calls.length = 0;
    await expect(fs.readFile(id, path)).rejects.toMatchObject({ code: 'locked' });
    expect(client.calls).toEqual([]);
    await access.open(id, async () => true);
    await client.lifecycle(id, 'sleep');
    client.calls.length = 0;
    await expect(fs.readFile(id, path)).rejects.toMatchObject({ code: 'unavailable' });
    expect(client.calls).toEqual(['getAgent']);
  });
  it('rejects path traversal and sibling volume paths', async () => {
    const { fs } = await setup();
    await expect(fs.readFile(id, '/data/../etc/passwd')).rejects.toMatchObject({ code: 'invalid' });
    await expect(fs.readFile(id, '/datafoo/secret')).rejects.toMatchObject({ code: 'permission' });
  });
  it('rejects malicious directory entries', async () => {
    const { fs, client } = await setup();
    vi.spyOn(client, 'listFiles').mockResolvedValue({
      root: '/data',
      path: '/data',
      entries: [{ name: '../etc', isDir: true, size: 0, mtime: 0 }],
    });
    await expect(fs.readDirectory(id, '/data')).rejects.toMatchObject({ code: 'invalid' });
  });
  it('serializes local saves and preserves the last successful content', async () => {
    const { fs } = await setup();
    await fs.readFile(id, path);
    await Promise.all([
      fs.writeFile(id, path, bytes('one'), { create: true, overwrite: true }),
      fs.writeFile(id, path, bytes('two'), { create: true, overwrite: true }),
    ]);
    expect(await fs.readFile(id, path)).toEqual(bytes('two'));
  });
  it('uses bounded hash baselines and invalidates descendants', () => {
    const cache = new FileCache(2);
    cache.set('a', '1');
    cache.set('b/child', '2');
    cache.set('c', '3');
    expect(cache.get('a')).toBeUndefined();
    cache.invalidate('b');
    expect(cache.get('b/child')).toBeUndefined();
    expect(fingerprint(bytes('x'))).not.toBe(fingerprint(bytes('y')));
  });
});

describe('filesystem session races', () => {
  it('never uploads after access is revoked during conflict checking', async () => {
    const { fs, client, access } = await setup();
    await fs.readFile(id, path);
    const original = client.download.bind(client);
    vi.spyOn(client, 'download').mockImplementationOnce(async (id, path) => {
      const result = await original(id, path);
      access.clear();
      return result;
    });
    await expect(
      fs.writeFile(id, path, bytes('new'), { create: true, overwrite: true }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(client.calls).not.toContain('upload');
  });
  it('does not emit success or replace the baseline after an upload failure', async () => {
    const { fs, client, changes } = await setup();
    await fs.readFile(id, path);
    vi.spyOn(client, 'upload').mockRejectedValueOnce(new Error('network error'));
    await expect(
      fs.writeFile(id, path, bytes('new'), { create: true, overwrite: true }),
    ).rejects.toThrow();
    expect(changes).not.toHaveBeenCalled();
    await fs.writeFile(id, path, bytes('retry'), { create: true, overwrite: true });
    expect(await fs.readFile(id, path)).toEqual(bytes('retry'));
  });
});

describe('Maritime zero-byte download compatibility', () => {
  it('reads and saves a listed empty file when download returns 404', async () => {
    const { fs, client } = await setup();
    const empty = '/data/workspace/empty';
    const download = vi.spyOn(client, 'download');
    download.mockRejectedValueOnce(new ApiError('missing'));
    expect(await fs.readFile(id, empty)).toEqual(new Uint8Array());
    download.mockRejectedValueOnce(new ApiError('missing'));
    await fs.writeFile(id, empty, bytes('now populated'), { create: false, overwrite: true });
    expect(await client.download(id, empty)).toEqual(bytes('now populated'));
  });
  it('preserves missing errors when the empty file was deleted', async () => {
    const { fs, client } = await setup();
    const empty = '/data/workspace/empty';
    vi.spyOn(client, 'download').mockImplementationOnce(async () => {
      await client.delete(id, empty);
      throw new ApiError('missing');
    });
    await expect(fs.readFile(id, empty)).rejects.toMatchObject({ code: 'missing' });
  });
  it('refuses empty-file synthesis when metadata changes during download', async () => {
    const { fs, client } = await setup();
    const empty = '/data/workspace/empty';
    vi.spyOn(client, 'download').mockImplementationOnce(async () => {
      await client.upload(id, empty, bytes('external'));
      throw new ApiError('missing');
    });
    await expect(fs.readFile(id, empty)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('does not hide 404 errors for nonempty files', async () => {
    const { fs, client } = await setup();
    vi.spyOn(client, 'download').mockRejectedValueOnce(new ApiError('missing'));
    await expect(fs.readFile(id, path)).rejects.toMatchObject({ code: 'missing' });
  });
});
