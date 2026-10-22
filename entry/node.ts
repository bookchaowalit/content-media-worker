/**
 * Node entry point: Docker, Railway, Render, Fly, Azure Container Apps,
 * Google Cloud Run, a VM, or a laptop. Same core as the Cloudflare entry.
 *
 *   node dist/node.mjs once     one tick, then exit (for external cron / Cloud Scheduler)
 *   node dist/node.mjs loop     tick every MEDIA_POLL_INTERVAL_SECONDS (default 300)
 *   node dist/node.mjs login    link OneDrive with a device code; stores the refresh token
 *   node dist/node.mjs transcribe --url … --name …   one URL, no OneDrive needed (see entry/tools.ts)
 *   node dist/node.mjs eval --manifest samples.json  score providers; --write updates own_eval
 *
 * MEDIA_STATE: upstash (any cloud) | file (needs a volume; MEDIA_STATE_PATH)
 * MEDIA_SINK:  onedrive (next to the video) | file (MEDIA_OUTPUT_DIR)
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as Sentry from '@sentry/node';
import { buildPipelineDeps, configurationProblems, selectKv } from '../core/config.js';
import { errorSummary } from '../core/http.js';
import { runTick } from '../core/pipeline.js';
import { sentryOptions } from '../core/sentry.js';
import type { KeyValueStore, MediaItem, OutputFile, OutputSink, WorkerLog } from '../core/types.js';
import { deviceCodeLogin, ONEDRIVE_REFRESH_KEY } from '../sources/onedrive.js';
import { evalCommand, transcribeCommand } from './tools.js';

/** JSON-file store for single-instance hosts with a persistent volume. */
class FileKv implements KeyValueStore {
  private cache: Record<string, string> | null = null;
  constructor(private readonly path: string) {}
  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.path, 'utf8'));
    } catch {
      this.cache = {};
    }
    return this.cache!;
  }
  private async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    await writeFile(temp, JSON.stringify(this.cache), { mode: 0o600 });
    await rename(temp, this.path);
    await chmod(this.path, 0o600);
  }
  async get(key: string) {
    return (await this.load())[key] ?? null;
  }
  async put(key: string, value: string) {
    (await this.load())[key] = value;
    await this.flush();
  }
  async delete(key: string) {
    delete (await this.load())[key];
    await this.flush();
  }
}

class FileSink implements OutputSink {
  readonly id = 'file';
  constructor(private readonly dir: string) {}
  async write(item: MediaItem, files: OutputFile[]): Promise<void> {
    const folder = join(this.dir, item.folder_path.replace(/[^\w฀-๿/ .-]/g, '_').replace(/^\/+/, ''));
    await mkdir(folder, { recursive: true });
    for (const file of files) await writeFile(join(folder, file.name.replace(/[\\/]/g, '_')), file.content, 'utf8');
  }
}

const log: WorkerLog = (event, fields = {}) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);

function stateStore(env: NodeJS.ProcessEnv): KeyValueStore {
  const fileKv = new FileKv(env.MEDIA_STATE_PATH || '.media-worker/state.json');
  return selectKv(env, fetch, (env.MEDIA_STATE || 'file') === 'file' ? fileKv : undefined);
}

async function main(mode: string): Promise<number> {
  const env = process.env;
  if (mode === 'transcribe') return transcribeCommand(process.argv.slice(3), env);
  if (mode === 'eval') return evalCommand(process.argv.slice(3), env);
  const kv = stateStore(env);

  if (mode === 'login') {
    if (!env.ONEDRIVE_CLIENT_ID) throw new Error('ONEDRIVE_CLIENT_ID is not set');
    const refreshToken = await deviceCodeLogin({
      clientId: env.ONEDRIVE_CLIENT_ID,
      tenant: env.ONEDRIVE_TENANT || 'consumers',
      fetch,
      prompt: message => process.stderr.write(`${message}\n`),
    });
    await kv.put(ONEDRIVE_REFRESH_KEY, refreshToken);
    process.stderr.write('OneDrive linked; refresh token stored in the configured state backend.\n');
    return 0;
  }

  const problems = configurationProblems(env);
  if (problems.length) {
    // Names only, never values; errorSummary would mask this joined list as "unexpected error".
    log('media.config_invalid', { problems: problems.join('; ') });
    return 1;
  }
  const extraSinks = { file: new FileSink(env.MEDIA_OUTPUT_DIR || 'media-output') };

  if (mode === 'once') {
    const deps = buildPipelineDeps({ env, fetch, kv, log, extraSinks });
    log('media.tick', { ...(await runTick(deps)) });
    return 0;
  }
  if (mode === 'loop') {
    const intervalMs = Math.max(30, Number(env.MEDIA_POLL_INTERVAL_SECONDS || 300)) * 1000;
    let stopping = false;
    process.on('SIGTERM', () => { stopping = true; });
    process.on('SIGINT', () => { stopping = true; });
    while (!stopping) {
      try {
        // Fresh deps each tick so a rotated access token is never reused past expiry.
        const deps = buildPipelineDeps({ env, fetch, kv, log, extraSinks });
        log('media.tick', { ...(await runTick(deps)) });
      } catch (error) {
        Sentry.captureException(error);
        log('media.tick_failed', { reason: errorSummary(error) });
      }
      const until = Date.now() + intervalMs;
      while (!stopping && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    return 0;
  }
  process.stderr.write('usage: node.mjs once|loop|login|transcribe|eval\n');
  return 2;
}

// Errors reach Sentry only when SENTRY_DSN is set (errors only; see core/sentry.ts).
Sentry.init(sentryOptions(process.env));

const flushSentry = async () => {
  if (Sentry.isEnabled()) await Sentry.flush(2_000);
};

main(process.argv[2] || 'once').then(
  async code => {
    await flushSentry();
    process.exit(code);
  },
  async error => {
    Sentry.captureException(error);
    log('media.startup_failed', { reason: errorSummary(error) });
    await flushSentry();
    process.exit(1);
  },
);
