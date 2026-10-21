import { posix } from 'node:path';
import { confined } from '../../filesystem/pathUtils';
export interface LiveCall {
  method: string;
  route: string;
  status?: number;
}
/** Test-only hard boundary: one agent, one disposable directory, one pwd, no chat/create. */
export class LiveGuard {
  readonly calls: LiveCall[] = [];
  cleanup = false;
  private normalCount = 0;
  private cleanupCount = 0;
  private executions = 0;
  private sleeps = 0;
  root?: string;
  directory?: string;
  execution?: { exitCode: number; stdout: string; stderr: string };
  logCount?: number;
  constructor(
    private readonly id: string,
    private readonly nativeFetch: typeof fetch,
  ) {}
  private within(path: unknown, root: string | undefined): boolean {
    if (typeof path !== 'string' || !root) return false;
    try {
      return confined(path, root) === path;
    } catch {
      return false;
    }
  }
  private withinDirectory(path: unknown): boolean {
    return this.within(path, this.directory);
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const base = `/api/agents/${this.id}`;
    if (url.origin !== 'https://api.maritime.sh')
      throw new Error('Live guard refused another origin');
    if (this.cleanup ? ++this.cleanupCount > 20 : ++this.normalCount > 200)
      throw new Error('Live request budget exhausted');
    const route = url.pathname;
    let allowed =
      method === 'GET' && (route === '/api/agents' || route === base || route === base + '/logs');
    if (
      method === 'GET' &&
      (route === base + '/files/list' || route === base + '/files/download')
    ) {
      const path = url.searchParams.get('path');
      allowed = path === null ? route.endsWith('/list') : this.within(path, this.root);
    }
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    if (method === 'POST' && route === base + '/files/mkdir')
      allowed = this.withinDirectory(record.path);
    if (method === 'POST' && route === base + '/files/upload' && init?.body instanceof FormData) {
      const filename = init.body.get('file');
      const dest = init.body.get('dest_dir');
      allowed =
        this.withinDirectory(dest) &&
        filename instanceof File &&
        filename.name !== '.' &&
        filename.name !== '..' &&
        filename.name === posix.basename(filename.name) &&
        !init.body.has('message');
    }
    if (method === 'POST' && route === base + '/files/move')
      allowed = this.withinDirectory(record.from) && this.withinDirectory(record.to);
    if (method === 'DELETE' && route === base + '/files/delete')
      allowed = this.withinDirectory(url.searchParams.get('path'));
    if (method === 'POST' && route === base + '/exec')
      allowed = JSON.stringify(record.command) === '["pwd"]' && ++this.executions === 1;
    if (method === 'POST' && route === base + '/sleep') allowed = ++this.sleeps === 1;
    if (!allowed) throw new Error('Live guard refused an operation outside the approved test');
    const call: LiveCall = { method, route };
    this.calls.push(call);
    const response = await this.nativeFetch(input, init);
    call.status = response.status;
    if (response.ok && route === base + '/files/list' && !this.root) {
      const v = (await response.clone().json()) as { root?: unknown };
      if (typeof v.root !== 'string' || v.root === '/' || !v.root.startsWith('/'))
        throw new Error('Invalid volume root');
      this.root = v.root;
    }
    if (response.ok && route === base + '/exec')
      this.execution = (await response.clone().json()) as {
        exitCode: number;
        stdout: string;
        stderr: string;
      };
    if (response.ok && route === base + '/logs') {
      const v: unknown = await response.clone().json();
      if (Array.isArray(v)) this.logCount = v.length;
    }
    return response;
  };
}
