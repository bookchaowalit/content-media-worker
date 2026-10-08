import { request } from '../core/http.js';
import type { FetchLike, KeyValueStore } from '../core/types.js';

/** In-process store for tests and single-run experiments. */
export class MemoryKv implements KeyValueStore {
  readonly data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async tryLock(key: string) {
    if (this.data.has(key)) return false;
    this.data.set(key, '1');
    return true;
  }
}

/**
 * Upstash Redis over its REST API. Fetch-only, so it works from every cloud,
 * PaaS, container or edge runtime without a driver or a persistent volume.
 */
export class UpstashKv implements KeyValueStore {
  constructor(private readonly url: string, private readonly token: string, private readonly fetchFn: FetchLike, private readonly prefix = 'media:') {}

  private async command(args: string[]): Promise<unknown> {
    const response = await request(
      this.fetchFn,
      this.url.replace(/\/$/, ''),
      { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) },
      { label: 'upstash' },
    );
    const body = (await response.json()) as { result?: unknown };
    return body.result ?? null;
  }

  async get(key: string) {
    const result = await this.command(['GET', this.prefix + key]);
    return typeof result === 'string' ? result : null;
  }
  async put(key: string, value: string) {
    await this.command(['SET', this.prefix + key, value]);
  }
  async delete(key: string) {
    await this.command(['DEL', this.prefix + key]);
  }
  async tryLock(key: string, ttlSeconds: number) {
    return (await this.command(['SET', this.prefix + key, '1', 'NX', 'EX', String(ttlSeconds)])) === 'OK';
  }
}

/** Shape of a Cloudflare Workers KV binding; it already satisfies KeyValueStore. */
export interface CloudflareKvBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function fromCloudflareKv(binding: CloudflareKvBinding): KeyValueStore {
  return {
    get: key => binding.get(key),
    put: (key, value) => binding.put(key, value),
    delete: key => binding.delete(key),
  };
}

export async function getJson<T>(kv: KeyValueStore, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function putJson(kv: KeyValueStore, key: string, value: unknown): Promise<void> {
  await kv.put(key, JSON.stringify(value));
}
