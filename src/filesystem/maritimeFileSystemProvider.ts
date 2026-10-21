import * as vscode from 'vscode';
import { ApiError, normalizeError } from '../api/errors';
import { parseUri } from './pathUtils';
import type { Change } from './remoteVolume';
import type { RemoteVolume } from './remoteVolume';
export function remoteUri(id: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: 'maritime', authority: id, path });
}
export class MaritimeFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  constructor(private readonly volume: RemoteVolume) {}
  emit(changes: Change[]): void {
    this.emitter.fire(
      changes.map((change) => ({
        uri: remoteUri(change.id, change.path),
        type:
          change.type === 'created'
            ? vscode.FileChangeType.Created
            : change.type === 'deleted'
              ? vscode.FileChangeType.Deleted
              : vscode.FileChangeType.Changed,
      })),
    );
  }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const safe = normalizeError(error);
      switch (safe.code) {
        case 'missing':
          throw vscode.FileSystemError.FileNotFound(safe.message);
        case 'exists':
          throw vscode.FileSystemError.FileExists(safe.message);
        case 'permission':
        case 'auth':
        case 'disconnected':
          throw vscode.FileSystemError.NoPermissions(safe.message);
        default:
          throw vscode.FileSystemError.Unavailable(safe.message);
      }
    }
  }
  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.run(async () => {
      const { id, path } = parseUri(uri);
      const stat = await this.volume.stat(id, path);
      return {
        type: stat.isDir ? vscode.FileType.Directory : vscode.FileType.File,
        ctime: 0,
        mtime: stat.mtime * 1000,
        size: stat.size,
      };
    });
  }
  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.run(async () => {
      const { id, path } = parseUri(uri);
      return (await this.volume.readDirectory(id, path)).map((entry) => [
        entry.name,
        entry.isDir ? vscode.FileType.Directory : vscode.FileType.File,
      ]);
    });
  }
  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.run(async () => {
      const { id, path } = parseUri(uri);
      return this.volume.readFile(id, path);
    });
  }
  writeFile(
    uri: vscode.Uri,
    bytes: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    return this.run(async () => {
      const { id, path } = parseUri(uri);
      await this.volume.writeFile(id, path, bytes, options);
    });
  }
  createDirectory(uri: vscode.Uri): Promise<void> {
    return this.run(async () => {
      const { id, path } = parseUri(uri);
      await this.volume.createDirectory(id, path);
    });
  }
  delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    return this.run(async () => {
      const { id, path } = parseUri(uri);
      await this.volume.delete(id, path, options.recursive);
    });
  }
  rename(from: vscode.Uri, to: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    return this.run(async () => {
      const a = parseUri(from);
      const b = parseUri(to);
      if (a.id !== b.id) throw new ApiError('permission');
      await this.volume.rename(a.id, a.path, b.path, options.overwrite);
    });
  }
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }
  dispose(): void {
    this.emitter.dispose();
  }
}
