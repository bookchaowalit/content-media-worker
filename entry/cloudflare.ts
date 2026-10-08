/**
 * Cloudflare Workers entry: a Cron Trigger runs one tick. State uses the
 * MEDIA_KV binding unless MEDIA_STATE=upstash. Secrets come from
 * `wrangler secret put`; nothing here reads the filesystem.
 */

import { buildPipelineDeps, configurationProblems, selectKv } from '../core/config.js';
import { runTick } from '../core/pipeline.js';
import type { WorkerLog } from '../core/types.js';
import { fromCloudflareKv, type CloudflareKvBinding } from '../state/kv.js';

type Env = Record<string, string | undefined> & { MEDIA_KV?: CloudflareKvBinding };

const log: WorkerLog = (event, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));

export default {
  async scheduled(_controller: unknown, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
    const problems = configurationProblems(env);
    if (problems.length) {
      log('media.config_invalid', { problems: problems.join('; ') });
      return;
    }
    const kv = selectKv(env, fetch, env.MEDIA_KV ? fromCloudflareKv(env.MEDIA_KV) : undefined);
    const deps = buildPipelineDeps({ env, fetch: (input, init) => fetch(input, init), kv, log });
    ctx.waitUntil(runTick(deps).then(result => log('media.tick', { ...result })));
  },

  /** Health only; no configuration detail and no manual trigger over HTTP. */
  async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'Content-Type': 'application/json' } });
  },
};
