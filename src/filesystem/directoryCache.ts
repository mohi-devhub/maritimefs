import type { FileList } from '../api/types';

/** UI metadata only. No timers, file bytes, or completed agent-status caching. */
export class DirectoryCache {
  private readonly values = new Map<string, { value: FileList; expires: number; weight: number }>();
  private readonly pending = new Map<string, Promise<FileList>>();
  private generation = 0;
  private weight = 0;
  constructor(
    private readonly ttl = 2000,
    private readonly budget = 2 * 1024 * 1024,
    private readonly now = Date.now,
  ) {}
  async get(key: string, load: () => Promise<FileList>): Promise<FileList> {
    const cached = this.values.get(key);
    if (cached && cached.expires > this.now()) return cached.value;
    if (cached) this.remove(key);
    const active = this.pending.get(key);
    if (active) return active;
    const generation = this.generation;
    const request = load().then((value) => {
      // A write/refresh/account change may have invalidated an in-flight read.
      if (generation === this.generation) {
        const weight = value.entries.reduce(
          (sum, entry) => sum + 128 + entry.name.length * 2,
          128 + (key.length + value.root.length + value.path.length) * 2,
        );
        if (weight <= this.budget) {
          this.remove(key);
          while (this.values.size && (this.weight + weight > this.budget || this.values.size >= 32))
            this.remove(this.values.keys().next().value!);
          this.values.set(key, { value, expires: this.now() + this.ttl, weight });
          this.weight += weight;
        }
      }
      return value;
    });
    this.pending.set(key, request);
    try {
      return await request;
    } finally {
      if (this.pending.get(key) === request) this.pending.delete(key);
    }
  }
  private remove(key: string): void {
    const entry = this.values.get(key);
    if (entry) this.weight -= entry.weight;
    this.values.delete(key);
  }
  clear(): void {
    ++this.generation;
    this.values.clear();
    this.pending.clear();
    this.weight = 0;
  }
}
