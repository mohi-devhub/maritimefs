import { ApiError } from '../api/errors';
import type { Agent, MaritimeClient } from '../api/types';
import { agentId, normalizePath } from '../filesystem/pathUtils';
/** In-memory approvals only; workspace restoration never grants access. */
export class AccessSession {
  private readonly roots = new Map<string, string>();
  private readonly checking = new Map<string, Promise<Agent>>();
  private revision = 0;
  get version(): number {
    return this.revision;
  }
  constructor(private readonly client: () => MaritimeClient) {}
  async open(id: string, confirmWake: () => Promise<boolean>): Promise<string> {
    agentId(id);
    const revision = this.revision;
    const client = this.client();
    const agent = await client.getAgent(id);
    if (agent.status === 'sleeping') {
      if (!(await confirmWake())) throw new ApiError('cancelled');
    } else if (agent.status !== 'active') throw new ApiError('unavailable');
    if (revision !== this.revision || client !== this.client()) throw new ApiError('cancelled');
    const listing = await client.listFiles(id);
    if (revision !== this.revision || client !== this.client()) throw new ApiError('cancelled');
    const root = normalizePath(listing.root);
    if (root === '/' || normalizePath(listing.path) !== root) throw new ApiError('invalid');
    this.roots.set(id, root);
    return root;
  }
  async require(id: string): Promise<string> {
    const client = this.client();
    const root = this.roots.get(id);
    if (!root) throw new ApiError('locked');
    const revision = this.revision;
    let request = this.checking.get(id);
    if (!request) {
      request = client.getAgent(id);
      this.checking.set(id, request);
    }
    let agent: Agent;
    try {
      agent = await request;
    } finally {
      if (this.checking.get(id) === request) this.checking.delete(id);
    }
    if (revision !== this.revision || client !== this.client()) throw new ApiError('cancelled');
    if (agent.status !== 'active') {
      this.roots.delete(id);
      throw new ApiError('unavailable');
    }
    return root;
  }
  root(id: string): string | undefined {
    return this.roots.get(id);
  }
  revoke(id: string): void {
    ++this.revision;
    this.roots.delete(id);
    this.checking.clear();
  }
  clear(): void {
    ++this.revision;
    this.roots.clear();
    this.checking.clear();
  }
}
