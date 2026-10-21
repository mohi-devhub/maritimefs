import { posix } from 'node:path';
import { ApiError } from '../api/errors';
import type { MaritimeClient, FileEntry, FileList } from '../api/types';
import { MAX_FILE_BYTES } from '../api/types';
import type { AccessSession } from '../services/accessSession';
import { FileCache, fingerprint } from './fileCache';
import { DirectoryCache } from './directoryCache';
import { confined, entryName, normalizePath } from './pathUtils';
export interface RemoteStat {
  isDir: boolean;
  size: number;
  mtime: number;
}
export interface Change {
  id: string;
  path: string;
  type: 'created' | 'changed' | 'deleted';
}
interface ClientLease {
  run<T>(operation: (client: MaritimeClient) => Promise<T>): Promise<T>;
}
export class RemoteVolume {
  /** A request sequence stays bound to its original account and approval generation. */
  private operationClient(id: string): ClientLease {
    const client = this.client();
    const revision = this.access.version;
    const assertCurrent = () => {
      if (client !== this.client() || revision !== this.access.version || !this.access.root(id))
        throw new ApiError('cancelled');
    };
    return {
      run: async (operation) => {
        assertCurrent();
        const result = await operation(client);
        assertCurrent();
        return result;
      },
    };
  }
  private readonly baseline = new FileCache();
  private readonly metadata = new DirectoryCache();
  private metadataRevision = -1;
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(
    private readonly client: () => MaritimeClient,
    private readonly access: AccessSession,
    private readonly trusted: () => boolean,
    private readonly confirmDelete: (id: string, path: string) => Promise<boolean>,
    private readonly changed: (events: Change[]) => void = () => {},
  ) {}
  private async check(id: string, path: string, mutate = false): Promise<string> {
    if (mutate && !this.trusted()) throw new ApiError('permission');
    return confined(path, await this.access.require(id));
  }
  private key(id: string, path: string): string {
    return id + ':' + path;
  }
  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const revision = this.access.version;
    const prior = this.locks.get(id) ?? Promise.resolve();
    const result = prior
      .catch(() => {})
      .then(async () => {
        if (revision !== this.access.version) throw new ApiError('cancelled');
        this.metadata.clear();
        try {
          return await operation();
        } finally {
          // Also discard metadata after an ambiguous/failed mutation.
          this.metadata.clear();
        }
      });
    this.locks.set(id, result);
    void result
      .finally(() => {
        if (this.locks.get(id) === result) this.locks.delete(id);
      })
      .catch(() => {});
    return result;
  }
  private async list(
    id: string,
    path: string,
    client: ClientLease,
    cached = false,
  ): Promise<FileList> {
    if (this.metadataRevision !== this.access.version) {
      this.metadata.clear();
      this.metadataRevision = this.access.version;
    }
    const load = async () => {
      const result = await client.run((c) => c.listFiles(id, path));
      if (
        normalizePath(result.root) !== this.access.root(id) ||
        normalizePath(result.path) !== path
      )
        throw new ApiError('invalid');
      const names = new Set<string>();
      for (const entry of result.entries) {
        entryName(entry.name);
        if (names.has(entry.name)) throw new ApiError('invalid');
        names.add(entry.name);
      }
      return result;
    };
    const result = cached
      ? await client.run(() => this.metadata.get(this.key(id, path), load))
      : await load();
    if (normalizePath(result.root) !== this.access.root(id) || normalizePath(result.path) !== path)
      throw new ApiError('invalid');
    return result;
  }
  private async info(
    id: string,
    path: string,
    client: ClientLease,
    cached = false,
  ): Promise<RemoteStat> {
    if (path === this.access.root(id)) return { isDir: true, size: 0, mtime: 0 };
    const parent = await this.list(id, posix.dirname(path), client, cached);
    const entry = parent.entries.find((e) => e.name === posix.basename(path));
    if (!entry) throw new ApiError('missing');
    return { ...entry };
  }
  async stat(id: string, path: string): Promise<RemoteStat> {
    path = await this.check(id, path);
    return this.info(id, path, this.operationClient(id), true);
  }
  async readDirectory(id: string, path: string): Promise<FileEntry[]> {
    path = await this.check(id, path);
    return (await this.list(id, path, this.operationClient(id), true)).entries.map((entry) => ({
      ...entry,
    }));
  }
  private async readBytes(
    id: string,
    path: string,
    stat: RemoteStat | undefined,
    client: ClientLease,
  ): Promise<Uint8Array> {
    try {
      return await client.run((c) => c.download(id, path));
    } catch (error) {
      // Observed on live Maritime: download returns 404 for a listed zero-byte file.
      // Confirm it still exists and is empty; never turn arbitrary missing files into empty content.
      if (
        !(error instanceof ApiError) ||
        error.code !== 'missing' ||
        (stat && (stat.isDir || stat.size !== 0))
      )
        throw error;
      const current = await this.info(id, path, client);
      if (current.isDir || current.size !== 0) throw new ApiError('conflict');
      return new Uint8Array();
    }
  }
  async readFile(id: string, path: string): Promise<Uint8Array> {
    path = await this.check(id, path);
    const client = this.operationClient(id);
    const stat = await this.info(id, path, client);
    if (stat.isDir) throw new ApiError('invalid');
    if (stat.size > MAX_FILE_BYTES) throw new ApiError('tooLarge');
    const bytes = await this.readBytes(id, path, stat, client);
    if (bytes.length > MAX_FILE_BYTES) throw new ApiError('tooLarge');
    this.baseline.set(this.key(id, path), fingerprint(bytes));
    return bytes;
  }
  writeFile(
    id: string,
    path: string,
    bytes: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    return this.serial(id, async () => {
      path = await this.check(id, path, true);
      const client = this.operationClient(id);
      if (bytes.length > MAX_FILE_BYTES) throw new ApiError('tooLarge');
      const expected = this.baseline.get(this.key(id, path));
      let existed = false;
      if (expected && options.overwrite) {
        let current: Uint8Array;
        try {
          // Fresh bytes prove existence and supply the conflict check. A parent
          // listing adds no protection here; only zero-byte 404s need metadata.
          current = await this.readBytes(id, path, undefined, client);
        } catch (error) {
          if (error instanceof ApiError && error.code === 'missing') throw new ApiError('conflict');
          throw error;
        }
        if (current.length > MAX_FILE_BYTES) throw new ApiError('tooLarge');
        if (fingerprint(current) !== expected) throw new ApiError('conflict');
        existed = true;
      } else {
        let stat: RemoteStat | undefined;
        try {
          stat = await this.info(id, path, client);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'missing') throw error;
        }
        if (stat) {
          if (stat.isDir || !options.overwrite) throw new ApiError('exists');
          throw new ApiError('conflict');
        }
        if (!options.create) throw new ApiError('missing');
        if (options.overwrite && (expected || this.baseline.wasRemoved(this.key(id, path))))
          throw new ApiError('conflict');
      }
      await client.run((c) => c.upload(id, path, bytes));
      // Keep the intended hash. A failed/ambiguous upload leaves the old baseline intact.
      this.baseline.set(this.key(id, path), fingerprint(bytes));
      this.changed([
        { id, path, type: existed ? 'changed' : 'created' },
        { id, path: posix.dirname(path), type: 'changed' },
      ]);
    });
  }
  createDirectory(id: string, path: string): Promise<void> {
    return this.serial(id, async () => {
      path = await this.check(id, path, true);
      const client = this.operationClient(id);
      await client.run((c) => c.mkdir(id, path));
      this.changed([
        { id, path, type: 'created' },
        { id, path: posix.dirname(path), type: 'changed' },
      ]);
    });
  }
  delete(id: string, path: string, recursive: boolean): Promise<void> {
    return this.serial(id, async () => {
      path = await this.check(id, path, true);
      const client = this.operationClient(id);
      if (path === this.access.root(id)) throw new ApiError('permission');
      const stat = await this.info(id, path, client);
      if (stat.isDir && !recursive && (await this.list(id, path, client)).entries.length)
        throw new ApiError('permission');
      if (!(await this.confirmDelete(id, path))) throw new ApiError('cancelled');
      await this.check(id, path, true);
      await client.run((c) => c.delete(id, path));
      this.baseline.retire(this.key(id, path));
      this.changed([
        { id, path, type: 'deleted' },
        { id, path: posix.dirname(path), type: 'changed' },
      ]);
    });
  }
  rename(id: string, from: string, to: string, _overwrite: boolean): Promise<void> {
    return this.serial(id, async () => {
      from = await this.check(id, from, true);
      const client = this.operationClient(id);
      to = confined(to, this.access.root(id)!);
      if (from === this.access.root(id) || to === this.access.root(id))
        throw new ApiError('permission');
      if (from === to) return;
      if (to.startsWith(from + '/')) throw new ApiError('invalid');
      // The documented move API rejects missing sources and existing destinations.
      // Always refuse collisions, including when VS Code requests overwrite.
      await client.run((c) => c.move(id, from, to));
      // VS Code may move dirty documents without reading their new URI first.
      // Transfer their read hashes and refuse late saves that recreate the source.
      this.baseline.move(this.key(id, from), this.key(id, to));
      const sameParent = posix.dirname(from) === posix.dirname(to);
      const [sourceParent, targetResult] = await Promise.all([
        this.list(id, posix.dirname(from), client),
        sameParent ? undefined : this.list(id, posix.dirname(to), client),
      ]);
      const targetParent = targetResult ?? sourceParent;
      if (
        sourceParent.entries.some((entry) => entry.name === posix.basename(from)) ||
        !targetParent.entries.some((entry) => entry.name === posix.basename(to))
      )
        throw new ApiError('moveIncomplete');
      this.changed([
        { id, path: from, type: 'deleted' },
        { id, path: to, type: 'created' },
        { id, path: posix.dirname(from), type: 'changed' },
        { id, path: posix.dirname(to), type: 'changed' },
      ]);
    });
  }
  refresh(id: string): void {
    this.metadata.clear();
    const root = this.access.root(id);
    if (root) this.changed([{ id, path: root, type: 'changed' }]);
  }
  clear(): void {
    this.baseline.clear();
    this.metadata.clear();
  }
}
