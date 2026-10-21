import { Maritime } from 'maritime-sdk';
import { posix } from 'node:path';
import { ApiError, normalizeError } from './errors';
import type { LifecycleAction, MaritimeClient } from './types';
import { MAX_FILE_BYTES } from './types';
import { Transport } from './transport';
import * as parse from './validation';
export class SdkMaritimeClient implements MaritimeClient {
  readonly simulated = false;
  private readonly sdk: Maritime;
  constructor(
    key: string,
    private readonly transport = new Transport(),
  ) {
    this.sdk = new Maritime({
      apiKey: key,
      baseUrl: 'https://api.maritime.sh',
      maxRetries: 0,
      timeout: 80_000,
      fetch: transport.fetch,
    });
  }
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw normalizeError(error);
    }
  }
  listAgents() {
    return this.call(async () => parse.array(await this.sdk.agents.list(), parse.agent));
  }
  getAgent(id: string) {
    return this.call(async () => parse.agent(await this.sdk.agents.get(id)));
  }
  listFiles(id: string, path?: string) {
    return this.call(async () => parse.fileList(await this.sdk.agents.files.list(id, path)));
  }
  download(id: string, path: string) {
    return this.call(() => this.sdk.agents.files.download(id, path));
  }
  async upload(id: string, path: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > MAX_FILE_BYTES) throw new ApiError('tooLarge');
    await this.call(async () => {
      const result = await this.sdk.agents.files.upload(id, {
        content: bytes,
        filename: posix.basename(path),
        destDir: posix.dirname(path),
      });
      if (!result.ok || result.path !== path || result.size !== bytes.byteLength)
        throw new ApiError('invalid');
    });
  }
  mkdir(id: string, path: string) {
    return this.call(() => this.sdk.agents.files.mkdir(id, path));
  }
  move(id: string, from: string, to: string) {
    return this.call(() => this.sdk.agents.files.move(id, from, to));
  }
  delete(id: string, path: string) {
    return this.call(() => this.sdk.agents.files.delete(id, path));
  }
  exec(id: string, argv: string[]) {
    return this.call(async () =>
      parse.execution(await this.sdk.agents.exec(id, argv, { timeout: 30 })),
    );
  }
  lifecycle(id: string, action: LifecycleAction) {
    return this.call(async () => parse.agent(await this.sdk.agents[action](id)));
  }
  logs(id: string) {
    return this.call(async () =>
      parse.array(await this.sdk.agents.logs(id, { limit: 100 }), parse.logEntry),
    );
  }
  dispose(): void {
    this.transport.dispose();
  }
}
