import { ApiError } from './errors';
import { MAX_FILE_BYTES } from './types';
import { canRetry, retryDelay, waitForRetry } from '../utils/retry';

/** SDK-injected fetch: fixed origin, bounded body/time, abort on disposal, safe GET retries only. */
export class Transport {
  private readonly pending = new Set<AbortController>();
  private disposed = false;
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeout = 75_000,
  ) {}
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.maritime.sh') throw new ApiError('invalid');
    if (this.disposed) throw new ApiError('cancelled');
    const controller = new AbortController();
    this.pending.add(controller);
    const signal = AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeout);
    const safe = canRetry(init?.method ?? 'GET', url.pathname);
    try {
      for (let attempt = 0; ; attempt++) {
        let response: Response;
        try {
          response = await this.fetchImpl(input, { ...init, signal, redirect: 'error' });
        } catch {
          if (!safe || attempt >= 2 || signal.aborted) throw new ApiError('network');
          await waitForRetry(retryDelay(attempt, null), signal);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (safe && attempt < 2 && [429, 500, 502, 503, 504].includes(response.status)) {
            await waitForRetry(retryDelay(attempt, response.headers.get('retry-after')), signal);
            continue;
          }
          // Never let upstream error bodies or reflected credentials reach the SDK.
          return new Response('{"detail":"Request refused"}', { status: response.status });
        }
        const limit = url.pathname.endsWith('/files/download') ? MAX_FILE_BYTES : 4 * 1024 * 1024;
        if (Number(response.headers.get('content-length')) > limit) {
          await response.body?.cancel();
          throw new ApiError('tooLarge');
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (reader) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > limit) {
              await reader.cancel();
              throw new ApiError('tooLarge');
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader?.releaseLock();
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return new Response(response.status === 204 ? null : bytes, {
          status: response.status,
          headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
        });
      }
    } catch (error) {
      if (timedOut) throw new ApiError('timeout');
      if (signal.aborted) throw new ApiError('cancelled');
      throw error instanceof ApiError ? error : new ApiError('network');
    } finally {
      clearTimeout(timer);
      this.pending.delete(controller);
    }
  };
  dispose(): void {
    this.disposed = true;
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }
}
