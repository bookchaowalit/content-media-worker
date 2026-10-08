import { OneDrive, OneDriveSink } from '../sources/onedrive.js';
import { UpstashKv } from '../state/kv.js';
import type { WorkerEnv } from '../stt/index.js';
import { createGatewaySummarizer } from '../summarize/gateway.js';
import type { PipelineDeps } from './pipeline.js';
import type { FetchLike, KeyValueStore, OutputSink, WorkerLog } from './types.js';

function required(env: WorkerEnv, name: string): string {
  const value = (env[name] || '').trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function intEnv(env: WorkerEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = (env[name] || '').trim();
  const value = raw ? Number(raw) : fallback;
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

const truthy = (raw: string | undefined) => ['1', 'true', 'yes', 'on'].includes((raw || '').trim().toLowerCase());

/**
 * Runtime-neutral state selection. MEDIA_STATE=upstash works on every
 * platform; runtimes with their own store (Cloudflare KV, a local file) pass
 * it in as `platformKv`.
 */
export function selectKv(env: WorkerEnv, fetchFn: FetchLike, platformKv?: KeyValueStore): KeyValueStore {
  const backend = (env.MEDIA_STATE || (platformKv ? 'platform' : 'upstash')).trim();
  if (backend === 'upstash') return new UpstashKv(required(env, 'UPSTASH_REDIS_REST_URL'), required(env, 'UPSTASH_REDIS_REST_TOKEN'), fetchFn);
  if (platformKv) return platformKv;
  throw new Error(`MEDIA_STATE=${backend} is not available on this runtime`);
}

/** Lists configuration problems by variable name only; never values. */
export function configurationProblems(env: WorkerEnv): string[] {
  const problems: string[] = [];
  for (const name of ['ONEDRIVE_CLIENT_ID', 'AI_GATEWAY_URL', 'AI_GATEWAY_TOKEN']) {
    if (!(env[name] || '').trim()) problems.push(`${name} is not set`);
  }
  return problems;
}

export function buildPipelineDeps(options: {
  env: WorkerEnv;
  fetch: FetchLike;
  kv: KeyValueStore;
  log?: WorkerLog;
  /** Runtime-specific sinks (e.g. a local directory) keyed by MEDIA_SINK value. */
  extraSinks?: Record<string, OutputSink>;
}): PipelineDeps & { drive: OneDrive } {
  const { env, kv } = options;
  const drive = new OneDrive({
    clientId: required(env, 'ONEDRIVE_CLIENT_ID'),
    kv,
    fetch: options.fetch,
    rootPath: env.ONEDRIVE_ROOT_PATH || '/Transcribe',
    tenant: env.ONEDRIVE_TENANT || 'consumers',
    bootstrapRefreshToken: env.ONEDRIVE_REFRESH_TOKEN,
    backfill: truthy(env.MEDIA_BACKFILL),
  });
  const sinkName = (env.MEDIA_SINK || 'onedrive').trim();
  const sinks: Record<string, OutputSink> = { onedrive: new OneDriveSink(drive), ...options.extraSinks };
  const sink = sinks[sinkName];
  if (!sink) throw new Error(`MEDIA_SINK=${sinkName} is not available on this runtime`);
  return {
    drive,
    source: drive,
    sink,
    kv,
    env,
    fetch: options.fetch,
    log: options.log,
    maxJobsPerTick: intEnv(env, 'MEDIA_MAX_JOBS_PER_TICK', 5, 1, 50),
    maxAttempts: intEnv(env, 'MEDIA_MAX_ATTEMPTS', 5, 1, 20),
    summarizer: createGatewaySummarizer({
      baseUrl: required(env, 'AI_GATEWAY_URL'),
      token: required(env, 'AI_GATEWAY_TOKEN'),
      fetch: options.fetch,
      chunkChars: intEnv(env, 'MEDIA_SUMMARY_CHUNK_CHARS', 24_000, 2_000, 190_000),
      tokenBudget: intEnv(env, 'MEDIA_SUMMARY_TOKEN_BUDGET', 16_384, 1_024, 131_072),
      maxOutputTokens: intEnv(env, 'MEDIA_SUMMARY_MAX_OUTPUT_TOKENS', 4_096, 256, 16_384),
    }),
  };
}
