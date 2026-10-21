import { ApiError } from '../api/errors';
import type { Agent, MaritimeClient } from '../api/types';
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}
export const SECRET_KEY = 'maritimefs.apiKey';
export class CredentialManager {
  private current?: MaritimeClient;
  private readonly pending = new Set<MaritimeClient>();
  private cancelPending(): void {
    for (const client of this.pending) client.dispose();
    this.pending.clear();
  }
  private revision = 0;
  private storageQueue: Promise<void> = Promise.resolve();
  private async secureStorage<T>(operation: () => PromiseLike<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('credentialStorage');
    }
  }
  private updateStorage(operation: () => PromiseLike<void>): Promise<void> {
    const result = this.storageQueue.catch(() => {}).then(() => this.secureStorage(operation));
    this.storageQueue = result;
    return result;
  }
  constructor(
    private readonly secrets: SecretStore,
    private readonly factory: (key: string) => MaritimeClient,
    private readonly changed: () => void = () => {},
  ) {}
  get connected(): boolean {
    return !!this.current;
  }
  get client(): MaritimeClient {
    if (!this.current) throw new ApiError('disconnected');
    return this.current;
  }
  async restore(): Promise<void> {
    if (this.current) return;
    const revision = this.revision;
    const key = await this.secureStorage(() => this.secrets.get(SECRET_KEY));
    if (key && revision === this.revision && !this.current) {
      this.current = this.factory(key);
      this.changed();
    }
  }
  async connect(key: string): Promise<Agent[]> {
    if (!key.trim() || /[\r\n]/.test(key)) throw new ApiError('invalid');
    const revision = ++this.revision;
    const candidate = this.factory(key.trim());
    this.pending.add(candidate);
    try {
      const agents = await candidate.listAgents();
      if (revision !== this.revision) throw new ApiError('cancelled');
      await this.updateStorage(async () => {
        if (revision !== this.revision) throw new ApiError('cancelled');
        await this.secrets.store(SECRET_KEY, key.trim());
      });
      if (revision !== this.revision) throw new ApiError('cancelled');
      this.current?.dispose();
      this.current = candidate;
      this.changed();
      return agents;
    } catch (error) {
      candidate.dispose();
      throw error;
    } finally {
      this.pending.delete(candidate);
    }
  }
  async disconnect(): Promise<void> {
    ++this.revision;
    this.cancelPending();
    this.current?.dispose();
    this.current = undefined;
    this.changed();
    await this.updateStorage(() => this.secrets.delete(SECRET_KEY));
  }
  dispose(): void {
    ++this.revision;
    this.cancelPending();
    this.current?.dispose();
    this.current = undefined;
  }
}
