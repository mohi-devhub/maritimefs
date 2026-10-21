import { createHash } from 'node:crypto';
export const fingerprint = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
/** Bounded read hashes and removed-path markers; never file contents. */
export class FileCache {
  private readonly values = new Map<string, string>();
  private readonly removed = new Map<string, true>();
  constructor(private readonly limit = 256) {}
  get(key: string): string | undefined {
    return this.values.get(key);
  }
  set(key: string, value: string): void {
    this.removed.delete(key);
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.limit) this.values.delete(this.values.keys().next().value!);
  }
  invalidate(prefix: string): void {
    for (const key of this.values.keys())
      if (key === prefix || key.startsWith(prefix + '/')) this.values.delete(key);
  }
  wasRemoved(key: string): boolean {
    return [...this.removed.keys()].some(
      (prefix) => key === prefix || key.startsWith(prefix + '/'),
    );
  }
  retire(prefix: string): void {
    this.invalidate(prefix);
    this.removed.delete(prefix);
    this.removed.set(prefix, true);
    while (this.removed.size > this.limit) this.removed.delete(this.removed.keys().next().value!);
  }
  move(from: string, to: string): void {
    const moved = [...this.values].filter(([key]) => key === from || key.startsWith(from + '/'));
    this.invalidate(to);
    for (const [key, hash] of moved) this.set(to + key.slice(from.length), hash);
    this.retire(from);
  }
  clear(): void {
    this.values.clear();
    this.removed.clear();
  }
}
