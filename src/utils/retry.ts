import { setTimeout as delay } from 'node:timers/promises';
export function retryDelay(attempt: number, retryAfter: string | null, now = Date.now()): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(duration)) return Math.max(0, Math.min(duration, 20_000));
  }
  return Math.min(500 * 2 ** attempt, 4_000);
}
export const waitForRetry = (ms: number, signal: AbortSignal): Promise<void> =>
  delay(ms, undefined, { signal });
export function canRetry(method: string, pathname: string): boolean {
  return method === 'GET' && /^\/api\/agents(?:\/[^/]+(?:\/logs)?)?$/.test(pathname);
}
