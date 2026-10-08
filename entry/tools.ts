/**
 * Node-only operator commands that need no OneDrive link:
 *
 *   transcribe  one media URL → transcript (+ summary when the gateway is set)
 *   eval        score configured providers against reference transcripts and,
 *               with --write, store the result as own_eval in the registry
 *
 * Media URLs come from arguments or a local manifest and are never printed.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  decideMediaRoute,
  DEFAULT_MEDIA_ROUTING_REGISTRY,
  type ContentKind,
  type MediaLanguage,
  type MediaRoutingRegistry,
} from '../../api/media_router.js';
import { errorSummary } from '../core/http.js';
import { errorRatePct, metricFor } from '../core/metrics.js';
import { buildOutputs } from '../core/pipeline.js';
import { transcribeAndWait } from '../core/transcribe.js';
import { createSttAdapter, type WorkerEnv } from '../stt/index.js';
import { createGatewaySummarizer } from '../summarize/gateway.js';

export function parseArgs(argv: string[]): Record<string, string | true> {
  const args: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[token.slice(2)] = next;
      index += 1;
    } else {
      args[token.slice(2)] = true;
    }
  }
  return args;
}

const text = (value: string | true | undefined): string | undefined => (typeof value === 'string' ? value : undefined);
const say = (line: string) => process.stderr.write(`${line}\n`);

export async function transcribeCommand(argv: string[], env: WorkerEnv): Promise<number> {
  const args = parseArgs(argv);
  const url = text(args.url);
  const name = text(args.name);
  if (!url || !name) {
    say('usage: transcribe --url <media-url> --name <file name> [--folder /Meetings] [--language th|en|mixed] [--kind meeting|video_edit|video_content] [--provider id] [--out dir] [--no-summary]');
    return 2;
  }
  const language = text(args.language) as MediaLanguage | undefined;
  const kind = text(args.kind) as ContentKind | undefined;
  const decision = decideMediaRoute(
    { file_name: name, folder_path: text(args.folder), hints: { ...(language ? { language } : {}), ...(kind ? { content_kind: kind } : {}) } },
    { env },
  );
  const providerId = text(args.provider) ?? decision.stt?.provider_id;
  if (!providerId) {
    say(`blocked: ${decision.blocked_reason}`);
    return 1;
  }
  const provider = DEFAULT_MEDIA_ROUTING_REGISTRY.providers[providerId];
  if (!provider) {
    say(`unknown provider ${providerId}`);
    return 2;
  }
  say(`kind=${decision.content_kind.value} (${decision.content_kind.reasons.join('; ')}) language=${decision.language.value} provider=${providerId}`);
  const adapter = createSttAdapter(providerId, provider, env, fetch);
  const routeLanguage = decision.language.value === 'th' || decision.language.value === 'en' ? decision.language.value : null;
  const transcript = await transcribeAndWait(
    adapter,
    { mediaUrl: url, model: provider.model, language: routeLanguage, diarization: decision.content_kind.value === 'meeting' },
    { onPending: elapsed => say(`waiting for ${providerId}… ${Math.round(elapsed / 1000)}s`) },
  );

  let summary: string | null = null;
  if (!args['no-summary'] && decision.summary && env.AI_GATEWAY_URL && env.AI_GATEWAY_TOKEN) {
    summary = await createGatewaySummarizer({ baseUrl: env.AI_GATEWAY_URL, token: env.AI_GATEWAY_TOKEN, fetch })
      .summarize({ ...decision.summary, file_name: name, transcript });
  } else if (!args['no-summary']) {
    say('summary skipped: AI_GATEWAY_URL / AI_GATEWAY_TOKEN not set');
  }
  const outDir = text(args.out) ?? env.MEDIA_OUTPUT_DIR ?? 'media-output';
  await mkdir(outDir, { recursive: true });
  for (const file of buildOutputs(name, decision, providerId, transcript, summary)) {
    const path = join(outDir, file.name.replace(/[\\/]/g, '_'));
    await writeFile(path, file.content, 'utf8');
    say(`wrote ${path}`);
  }
  return 0;
}

export interface EvalSample {
  url: string;
  reference: string;
  language: MediaLanguage;
}

export interface EvalRow {
  provider_id: string;
  language: MediaLanguage;
  metric: 'cer' | 'wer';
  samples: number;
  failures: number;
  error_rate_pct: number | null;
  audio_hours: number;
  est_cost_usd: number | null;
  avg_latency_s: number | null;
}

/** Mean error rate per provider and language; failed runs are counted, not scored. */
export function summarizeEval(
  results: Array<{ provider_id: string; language: MediaLanguage; error_rate_pct: number | null; duration_seconds: number | null; latency_s: number }>,
  registry: MediaRoutingRegistry,
): EvalRow[] {
  const groups = new Map<string, typeof results>();
  for (const result of results) {
    const key = `${result.provider_id}|${result.language}`;
    groups.set(key, [...(groups.get(key) || []), result]);
  }
  const rows: EvalRow[] = [];
  for (const [key, group] of groups) {
    const [providerId, language] = key.split('|') as [string, MediaLanguage];
    const scored = group.filter(item => item.error_rate_pct !== null);
    const hours = scored.reduce((sum, item) => sum + (item.duration_seconds ?? 0), 0) / 3600;
    const price = registry.providers[providerId]?.pricing?.usd_per_hour ?? null;
    rows.push({
      provider_id: providerId,
      language,
      metric: metricFor(language),
      samples: scored.length,
      failures: group.length - scored.length,
      error_rate_pct: scored.length ? Math.round((scored.reduce((sum, item) => sum + item.error_rate_pct!, 0) / scored.length) * 100) / 100 : null,
      audio_hours: Math.round(hours * 1000) / 1000,
      est_cost_usd: price === null ? null : Math.round(price * hours * 1000) / 1000,
      avg_latency_s: scored.length ? Math.round(scored.reduce((sum, item) => sum + item.latency_s, 0) / scored.length) : null,
    });
  }
  return rows.sort((a, b) => a.language.localeCompare(b.language) || (a.error_rate_pct ?? Infinity) - (b.error_rate_pct ?? Infinity));
}

/** Writes each provider's fresh result into own_eval, keeping other languages. */
export function applyOwnEval(registry: MediaRoutingRegistry, rows: EvalRow[], evaluatedAt: string): MediaRoutingRegistry {
  const next = structuredClone(registry);
  for (const row of rows) {
    if (row.error_rate_pct === null || row.samples === 0) continue;
    const provider = next.providers[row.provider_id];
    if (!provider) continue;
    const previous = provider.own_eval;
    provider.own_eval = {
      evaluated_at: evaluatedAt,
      sample_count: row.samples,
      wer_pct: { ...(previous?.wer_pct || {}), [row.language]: row.error_rate_pct },
      metric: { ...(previous?.metric || {}), [row.language]: row.metric },
    };
  }
  next.updated_at = evaluatedAt;
  return next;
}

export async function evalCommand(argv: string[], env: WorkerEnv): Promise<number> {
  const args = parseArgs(argv);
  const manifestPath = text(args.manifest);
  if (!manifestPath) {
    say('usage: eval --manifest samples.json [--providers id,id] [--out dir] [--write] [--registry path]');
    say('samples.json: [{ "url": "<media url>", "reference": "reference.txt", "language": "th" }]');
    return 2;
  }
  const registryPath = resolve(text(args.registry) ?? env.MEDIA_ROUTING_REGISTRY_PATH ?? 'infra/platform/media-transcription-routing.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8')) as MediaRoutingRegistry;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as EvalSample[];
  const only = text(args.providers)?.split(',').map(id => id.trim()).filter(Boolean);

  const results: Parameters<typeof summarizeEval>[0] = [];
  for (const [index, sample] of manifest.entries()) {
    const reference = await readFile(resolve(dirname(manifestPath), sample.reference), 'utf8');
    const candidates = (registry.stt_routes[sample.language] || [])
      .filter(id => !only || only.includes(id))
      .filter(id => (env[registry.providers[id]?.credential_env] || '').trim());
    if (!candidates.length) say(`sample ${index + 1}: no configured provider for ${sample.language}`);
    await Promise.all(candidates.map(async providerId => {
      const provider = registry.providers[providerId];
      const started = Date.now();
      try {
        const transcript = await transcribeAndWait(createSttAdapter(providerId, provider, env, fetch), {
          mediaUrl: sample.url,
          model: provider.model,
          language: sample.language === 'mixed' ? null : sample.language,
          diarization: false,
        });
        const rate = errorRatePct(reference, transcript.text, metricFor(sample.language));
        results.push({ provider_id: providerId, language: sample.language, error_rate_pct: rate, duration_seconds: transcript.duration_seconds, latency_s: (Date.now() - started) / 1000 });
        say(`sample ${index + 1} ${providerId}: ${metricFor(sample.language)} ${rate}%`);
      } catch (error) {
        results.push({ provider_id: providerId, language: sample.language, error_rate_pct: null, duration_seconds: null, latency_s: (Date.now() - started) / 1000 });
        say(`sample ${index + 1} ${providerId}: failed (${errorSummary(error)})`);
      }
    }));
  }

  const rows = summarizeEval(results, registry);
  const today = new Date().toISOString().slice(0, 10);
  const outDir = text(args.out) ?? '.media-worker';
  await mkdir(outDir, { recursive: true });
  const reportPath = join(outDir, `eval-report-${today}.json`);
  await writeFile(reportPath, JSON.stringify({ contract: 'solo-empire.media-stt-eval.v1', evaluated_at: today, rows }, null, 2));
  console.table(rows);
  say(`report: ${reportPath}`);
  if (args.write) {
    await writeFile(registryPath, `${JSON.stringify(applyOwnEval(registry, rows, today), null, 2)}\n`);
    say(`own_eval written to ${registryPath}; rebuild/redeploy the worker so the bundled registry picks it up`);
  }
  return rows.some(row => row.samples > 0) ? 0 : 1;
}
