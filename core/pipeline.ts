import { decideMediaRoute, DEFAULT_MEDIA_ROUTING_REGISTRY, type MediaRouteDecision, type MediaRoutingRegistry } from '../../api/media_router.js';
import { getJson, putJson } from '../state/kv.js';
import { createSttAdapter, type WorkerEnv } from '../stt/index.js';
import { errorSummary, isRetryable } from './http.js';
import { toSrt } from './transcript.js';
import type { FetchLike, KeyValueStore, MediaItem, MediaSource, OutputSink, SttAdapter, Summarizer, Transcript, WorkerLog } from './types.js';

export const JOB_RECORD_CONTRACT = 'solo-empire.media-job.v1' as const;
const ACTIVE_KEY = 'jobs:active';

export type JobStatus = 'queued' | 'submitting' | 'submitted' | 'transcribed' | 'done' | 'failed' | 'blocked';

const ACTIVE_STATUSES: ReadonlySet<JobStatus> = new Set(['queued', 'submitting', 'submitted', 'transcribed']);
const LOCK_KEY = 'lock:tick';
const SUBMITTING_GRACE_MINUTES = 30;
const SUBMITTED_MAX_HOURS = 24;

export interface JobRecord {
  contract: typeof JOB_RECORD_CONTRACT;
  item: MediaItem;
  status: JobStatus;
  decision: Pick<MediaRouteDecision, 'content_kind' | 'language' | 'needs_review' | 'summary' | 'warnings'> & { blocked_reason?: string };
  provider_id: string | null;
  /** Remaining providers to try, best first, after the current one fails. */
  fallback_provider_ids: string[];
  provider_job_id: string | null;
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PipelineDeps {
  source: MediaSource;
  sink: OutputSink;
  summarizer: Summarizer;
  kv: KeyValueStore;
  env: WorkerEnv;
  fetch: FetchLike;
  registry?: MediaRoutingRegistry;
  log?: WorkerLog;
  now?: () => Date;
  maxJobsPerTick?: number;
  maxAttempts?: number;
  /** Lease length for the per-tick lock on stores that support it. */
  lockSeconds?: number;
  /** Override for tests; defaults to the registry-driven adapter factory. */
  sttFactory?: (providerId: string) => SttAdapter;
}

export interface TickResult {
  discovered: number;
  advanced: number;
  done: number;
  failed: number;
  active: number;
  skipped_locked: boolean;
}

const jobKey = (id: string) => `job:${id}`;
const transcriptKey = (id: string) => `transcript:${id}`;
const summaryKey = (id: string) => `summary:${id}`;

function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function summaryHeader(job: JobRecord, transcript: Transcript): string {
  const lines = [
    `> ชนิด: ${job.decision.content_kind.value} (มั่นใจ ${job.decision.content_kind.confidence}) · ภาษา: ${transcript.language ?? job.decision.language.value} · ถอดเสียงโดย: ${job.provider_id}`,
  ];
  if (job.decision.needs_review) lines.push('> ⚠️ ระบบไม่มั่นใจชนิดไฟล์ ถ้าผิดให้เติมแท็ก [meeting] / [edit] / [clip] ในชื่อไฟล์แล้วอัปโหลดใหม่');
  return `${lines.join('\n')}\n\n`;
}

/**
 * One bounded pass: discover new media, then advance active jobs one step
 * each. Every step is idempotent and persisted, so any scheduler (cron,
 * a loop, a queue trigger) on any runtime can call it repeatedly.
 */
export async function runTick(deps: PipelineDeps): Promise<TickResult> {
  const registry = deps.registry ?? DEFAULT_MEDIA_ROUTING_REGISTRY;
  const log: WorkerLog = deps.log ?? (() => undefined);
  const clock = () => (deps.now ? deps.now() : new Date());
  const now = () => clock().toISOString();
  const maxJobs = deps.maxJobsPerTick ?? 5;
  const maxAttempts = deps.maxAttempts ?? 5;
  const sttFor = deps.sttFactory ?? ((id: string) => createSttAdapter(id, registry.providers[id], deps.env, deps.fetch));
  const result: TickResult = { discovered: 0, advanced: 0, done: 0, failed: 0, active: 0, skipped_locked: false };

  // Overlapping ticks (a slow run plus the next cron) would resubmit jobs and
  // pay twice. Stores with an atomic lock use it; others rely on one scheduler.
  const lockSeconds = deps.lockSeconds ?? 900;
  if (deps.kv.tryLock && !(await deps.kv.tryLock(LOCK_KEY, lockSeconds))) {
    log('media.tick_skipped', { reason: 'another tick holds the lock' });
    return { ...result, skipped_locked: true };
  }
  try {
    const active = new Set((await getJson<string[]>(deps.kv, ACTIVE_KEY)) || []);
    const saveActive = () => putJson(deps.kv, ACTIVE_KEY, [...active]);

    // 1. Discover.
    const changes = await deps.source.listChanges();
    for (const item of changes.items) {
      const existing = await getJson<JobRecord>(deps.kv, jobKey(item.id));
      if (existing) {
        // Recover a job saved before a crash left it outside the active set.
        if (ACTIVE_STATUSES.has(existing.status)) active.add(item.id);
        continue;
      }
      const decision = decideMediaRoute(
        { file_name: item.name, folder_path: item.folder_path, mime_type: item.mime_type, duration_seconds: item.duration_seconds ?? undefined },
        { registry, env: deps.env },
      );
      const fallbacks = decision.stt?.skipped.filter(entry => entry.reason.startsWith('ranked below')).map(entry => entry.provider_id) ?? [];
      const job: JobRecord = {
        contract: JOB_RECORD_CONTRACT,
        item,
        status: decision.status === 'routed' ? 'queued' : 'blocked',
        decision: {
          content_kind: decision.content_kind,
          language: decision.language,
          needs_review: decision.needs_review,
          summary: decision.summary,
          warnings: decision.warnings,
          ...(decision.blocked_reason ? { blocked_reason: decision.blocked_reason } : {}),
        },
        provider_id: decision.stt?.provider_id ?? null,
        fallback_provider_ids: fallbacks,
        provider_job_id: null,
        attempts: 0,
        error: decision.blocked_reason ?? null,
        created_at: now(),
        updated_at: now(),
      };
      // Active set first: a crash between the two writes leaves an id without a
      // record (dropped below), never a queued record outside the active set.
      if (job.status === 'queued') {
        active.add(item.id);
        await saveActive();
      }
      await putJson(deps.kv, jobKey(item.id), job);
      result.discovered += 1;
      log('media.discovered', { item_id: item.id, status: job.status, content_kind: decision.content_kind.value, language: decision.language.value, provider: job.provider_id });
    }
    await saveActive();
    await changes.commit();

    // 2. Advance active jobs, least recently touched first, so stuck jobs
    // cannot starve the rest of the queue.
    const jobs: JobRecord[] = [];
    for (const id of active) {
      const job = await getJson<JobRecord>(deps.kv, jobKey(id));
      if (job && ACTIVE_STATUSES.has(job.status)) jobs.push(job);
      else active.delete(id);
    }
    jobs.sort((a, b) => a.updated_at.localeCompare(b.updated_at));

    for (const job of jobs.slice(0, maxJobs)) {
      const id = job.item.id;
      const save = async (patch: Partial<JobRecord>) => {
        Object.assign(job, patch, { updated_at: now() });
        await putJson(deps.kv, jobKey(id), job);
      };
      const finalFail = async (reason: string) => {
        active.delete(id);
        result.failed += 1;
        log('media.failed', { item_id: id, status: job.status, reason });
        await deps.kv.delete(transcriptKey(id));
        await deps.kv.delete(summaryKey(id));
        await save({ status: 'failed', attempts: job.attempts + 1, error: reason });
      };
      const fail = async (reason: string, retryable: boolean, allowFallback = true) => {
        const attempts = job.attempts + 1;
        if (retryable && attempts < maxAttempts) return save({ attempts, error: reason });
        const [next, ...rest] = job.fallback_provider_ids;
        const sttStage = job.status === 'queued' || job.status === 'submitting' || job.status === 'submitted';
        if (allowFallback && next && sttStage) {
          log('media.fallback', { item_id: id, from: job.provider_id, to: next });
          return save({ status: 'queued', provider_id: next, fallback_provider_ids: rest, provider_job_id: null, attempts: 0, error: reason });
        }
        return finalFail(reason);
      };
      const ageMinutes = (Date.parse(now()) - Date.parse(job.updated_at)) / 60_000;

      try {
        const route = job.decision.summary;
        if (job.status === 'submitting') {
          // A previous tick crashed between marking and recording the submit.
          // Wait before resubmitting; the provider may still hold that job.
          if (ageMinutes < SUBMITTING_GRACE_MINUTES) continue;
          await save({ status: 'queued' });
        }
        if (job.status === 'queued') {
          const providerId = job.provider_id!;
          const provider = registry.providers[providerId];
          const stt = sttFor(providerId);
          let mediaUrl: string;
          try {
            mediaUrl = await deps.source.mediaUrl(job.item);
          } catch (error) {
            // Source problems (file deleted, link revoked) are not the provider's fault.
            await fail(`source: ${errorSummary(error)}`, isRetryable(error), false);
            continue;
          }
          await save({ status: 'submitting' });
          const language = job.decision.language.value === 'th' || job.decision.language.value === 'en' ? job.decision.language.value : null;
          const outcome = await stt.submit({ mediaUrl, model: provider.model, language, diarization: job.decision.content_kind.value === 'meeting' });
          if (outcome.kind === 'job') {
            await save({ status: 'submitted', provider_job_id: outcome.jobId, error: null });
          } else {
            await putJson(deps.kv, transcriptKey(id), outcome.transcript);
            await save({ status: 'transcribed', error: null, attempts: 0 });
          }
        } else if (job.status === 'submitted') {
          if (ageMinutes > SUBMITTED_MAX_HOURS * 60) {
            await fail('provider job exceeded the maximum wait', false);
            continue;
          }
          const outcome = await sttFor(job.provider_id!).poll(job.provider_job_id!);
          if (outcome.state === 'failed') {
            await fail(outcome.reason, false);
            continue;
          }
          if (outcome.state === 'pending') continue;
          await putJson(deps.kv, transcriptKey(id), outcome.transcript);
          await save({ status: 'transcribed', error: null, attempts: 0 });
        } else if (job.status === 'transcribed') {
          if (!route) {
            await finalFail('decision has no summary profile');
            continue;
          }
          const transcript = await getJson<Transcript>(deps.kv, transcriptKey(id));
          if (!transcript) {
            await finalFail('transcript missing from state');
            continue;
          }
          // Keep the summary so a failed sink write retries without paying for a new one.
          let summary = await deps.kv.get(summaryKey(id));
          if (summary === null) {
            summary = await deps.summarizer.summarize({ ...route, file_name: job.item.name, transcript });
            await deps.kv.put(summaryKey(id), summary);
          }
          const base = baseName(job.item.name);
          await deps.sink.write(job.item, [
            { name: `${base}.summary.md`, content: `# ${job.item.name}\n\n${summaryHeader(job, transcript)}${summary}\n`, content_type: 'text/markdown; charset=utf-8' },
            { name: `${base}.transcript.srt`, content: toSrt(transcript), content_type: 'application/x-subrip; charset=utf-8' },
            {
              name: `${base}.transcript.json`,
              content: JSON.stringify({ contract: 'solo-empire.media-transcript.v1', decision: job.decision, transcript }, null, 2),
              content_type: 'application/json; charset=utf-8',
            },
          ]);
          await deps.kv.delete(transcriptKey(id));
          await deps.kv.delete(summaryKey(id));
          await save({ status: 'done', error: null });
          active.delete(id);
          result.done += 1;
          log('media.done', { item_id: id, provider: job.provider_id, segments: transcript.segments.length });
        }
        result.advanced += 1;
      } catch (error) {
        await fail(errorSummary(error), isRetryable(error));
      }
    }

    await saveActive();
    result.active = active.size;
    return result;
  } finally {
    if (deps.kv.tryLock) await deps.kv.delete(LOCK_KEY);
  }
}
