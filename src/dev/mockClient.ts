import { posix } from 'node:path';
import { ApiError } from '../api/errors';
import type { ErrorCode } from '../api/errors';
import type { Agent, FileList, LifecycleAction, MaritimeClient } from '../api/types';
import { confined } from '../filesystem/pathUtils';
interface Node {
  bytes?: Uint8Array;
  mtime: number;
}
/** Explicit deterministic simulation. Never selected in response to a real API error. */
export class MockMaritimeClient implements MaritimeClient {
  readonly simulated = true;
  readonly agents: Agent[] = [
    { id: 'mock-active', name: 'SIMULATED research-agent', status: 'active' },
    { id: 'mock-sleeping', name: 'SIMULATED coding-agent', status: 'sleeping' },
    { id: 'mock-error', name: 'SIMULATED browser-agent', status: 'error' },
  ];
  readonly calls: string[] = [];
  readonly files = new Map<string, Map<string, Node>>();
  failNext?: ErrorCode;
  disposed = false;
  private tick = 1_700_000_000;
  constructor() {
    for (const a of this.agents)
      this.files.set(
        a.id,
        new Map([
          ['/data', { mtime: this.tick }],
          ['/data/workspace', { mtime: this.tick }],
          [
            '/data/workspace/hello.txt',
            { mtime: this.tick, bytes: new TextEncoder().encode('Hello from MaritimeFS\n') },
          ],
          ['/data/workspace/empty', { mtime: this.tick, bytes: new Uint8Array() }],
          [
            '/data/workspace/binary.bin',
            { mtime: this.tick, bytes: new Uint8Array([0, 255, 128, 1]) },
          ],
        ]),
      );
  }
  private check(method: string, id?: string): void {
    this.calls.push(method);
    if (this.disposed) throw new ApiError('cancelled');
    if (this.failNext) {
      const code = this.failNext;
      this.failNext = undefined;
      throw new ApiError(code);
    }
    if (id && !this.agents.some((a) => a.id === id)) throw new ApiError('missing');
  }
  async listAgents(): Promise<Agent[]> {
    this.check('listAgents');
    return this.agents.map((a) => ({ ...a }));
  }
  async getAgent(id: string): Promise<Agent> {
    this.check('getAgent', id);
    return { ...this.agents.find((a) => a.id === id)! };
  }
  private volume(id: string): Map<string, Node> {
    const a = this.agents.find((a) => a.id === id)!;
    if (a.status === 'sleeping') a.status = 'active';
    if (a.status !== 'active') throw new ApiError('unavailable');
    return this.files.get(id)!;
  }
  async listFiles(id: string, path = '/data'): Promise<FileList> {
    this.check('listFiles', id);
    confined(path, '/data');
    const nodes = this.volume(id);
    const dir = nodes.get(path);
    if (!dir) throw new ApiError('missing');
    if (dir.bytes) throw new ApiError('invalid');
    return {
      root: '/data',
      path,
      entries: [...nodes.entries()]
        .filter(([p]) => p !== path && posix.dirname(p) === path)
        .map(([p, n]) => ({
          name: posix.basename(p),
          isDir: n.bytes === undefined,
          size: n.bytes?.byteLength ?? 0,
          mtime: n.mtime,
        })),
    };
  }
  async download(id: string, path: string): Promise<Uint8Array> {
    this.check('download', id);
    confined(path, '/data');
    const n = this.volume(id).get(path);
    if (!n) throw new ApiError('missing');
    if (!n.bytes) throw new ApiError('invalid');
    return n.bytes.slice();
  }
  async upload(id: string, path: string, bytes: Uint8Array): Promise<void> {
    this.check('upload', id);
    confined(path, '/data');
    const nodes = this.volume(id);
    if (!nodes.has(posix.dirname(path))) throw new ApiError('missing');
    if (nodes.get(path) && !nodes.get(path)?.bytes) throw new ApiError('exists');
    nodes.set(path, { bytes: bytes.slice(), mtime: ++this.tick });
  }
  async mkdir(id: string, path: string): Promise<void> {
    this.check('mkdir', id);
    confined(path, '/data');
    const nodes = this.volume(id);
    let current = '';
    for (const segment of path.split('/').filter(Boolean)) {
      current += '/' + segment;
      if (nodes.get(current)?.bytes) throw new ApiError('exists');
      if (!nodes.has(current)) nodes.set(current, { mtime: ++this.tick });
    }
  }
  async move(id: string, from: string, to: string): Promise<void> {
    this.check('move', id);
    confined(from, '/data');
    confined(to, '/data');
    const nodes = this.volume(id);
    if (!nodes.has(from)) throw new ApiError('missing');
    if (nodes.has(to)) throw new ApiError('exists');
    await this.mkdir(id, posix.dirname(to));
    for (const [p, n] of [...nodes])
      if (p === from || p.startsWith(from + '/')) {
        nodes.set(to + p.slice(from.length), n);
        nodes.delete(p);
      }
  }
  async delete(id: string, path: string): Promise<void> {
    this.check('delete', id);
    confined(path, '/data');
    if (path === '/data') throw new ApiError('permission');
    const nodes = this.volume(id);
    if (!nodes.has(path)) throw new ApiError('missing');
    for (const p of nodes.keys()) if (p === path || p.startsWith(path + '/')) nodes.delete(p);
  }
  async exec(id: string, argv: string[]) {
    this.check('exec', id);
    this.volume(id);
    return argv.length === 1 && argv[0] === 'pwd'
      ? { exitCode: 0, stdout: '/data\n', stderr: '' }
      : { exitCode: 127, stdout: '', stderr: 'SIMULATED: only pwd is implemented\n' };
  }
  async lifecycle(id: string, action: LifecycleAction): Promise<Agent> {
    this.check('lifecycle', id);
    const a = this.agents.find((a) => a.id === id)!;
    a.status = action === 'sleep' ? 'sleeping' : 'active';
    return { ...a };
  }
  async logs(id: string) {
    this.check('logs', id);
    return [
      {
        id: 'mock-log',
        timestamp: '2023-11-14T22:13:20.000Z',
        level: 'info',
        message: 'SIMULATED agent ready',
      },
    ];
  }
  dispose(): void {
    this.disposed = true;
  }
}
