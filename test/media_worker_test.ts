import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configurationProblems, selectKv } from '../core/config.js';
import { ProviderHttpError, requestJson } from '../core/http.js';
import { runTick, type JobRecord } from '../core/pipeline.js';
import { joinTokens, segmentWords, toSrt } from '../core/transcript.js';
import type { FetchLike, MediaItem, OutputFile, OutputSink, Transcript } from '../core/types.js';
import { OneDrive, ONEDRIVE_REFRESH_KEY, toMediaItem } from '../sources/onedrive.js';
import { MemoryKv } from '../state/kv.js';
import { normalizeAssemblyAi } from '../stt/assemblyai.js';
import { normalizeAzure } from '../stt/azure.js';
import { normalizeDeepgram } from '../stt/deepgram.js';
import { normalizeElevenLabs } from '../stt/elevenlabs.js';
import { normalizeGladia } from '../stt/gladia.js';
import { normalizeSpeechmatics } from '../stt/speechmatics.js';
import { createGatewaySummarizer, splitLines } from '../summarize/gateway.js';

// Synthetic markers: if any of these leaks into state, logs or outputs, a test fails.
const SIGNED_URL = 'https://public.dm.files.1drv.com/SIGNED-DOWNLOAD-MARKER-5531/video.mp4';
const GATEWAY_TOKEN = 'GATEWAY-TOKEN-MARKER-8812';
const PROVIDER_KEY = 'PROVIDER-KEY-MARKER-2290';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Handler = (call: Call) => unknown | Response | undefined;

function fakeFetch(handlers: Array<[RegExp, Handler]>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers as HeadersInit).entries());
    let body: unknown = init.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* keep text */ }
    }
    const call = { url, method: init.method || 'GET', headers, body };
    calls.push(call);
    for (const [pattern, handler] of handlers) {
      if (pattern.test(`${call.method} ${url}`)) {
        const result = handler(call);
        if (result instanceof Response) return result;
        return new Response(JSON.stringify(result ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response('{"error":"unexpected"}', { status: 404 });
  };
  return { fetch: fetchFn, calls };
}

test('Thai tokens join without spaces while English and punctuation stay readable', () => {
  assert.equal(joinTokens(['สวัสดี', 'ครับ', 'Weekly', 'sync', 'นะ', 'ครับ', '.']), 'สวัสดีครับ Weekly sync นะครับ.');
  const segments = segmentWords([
    { start: 0, end: 0.5, speaker: 'S1', text: 'เริ่ม' },
    { start: 0.5, end: 1, speaker: 'S1', text: 'ประชุม' },
    { start: 1.2, end: 2, speaker: 'S2', text: 'ok' },
    { start: 6, end: 7, speaker: 'S2', text: 'next' },
  ]);
  assert.deepEqual(segments.map(segment => [segment.speaker, segment.text]), [['S1', 'เริ่มประชุม'], ['S2', 'ok'], ['S2', 'next']]);
  const srt = toSrt({ provider_id: 'x', language: 'th', duration_seconds: 7, text: '', segments });
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,000\n\[S1\] เริ่มประชุม\n/);
});

test('every STT adapter normalizes into the same transcript shape', () => {
  const speechmatics = normalizeSpeechmatics('speechmatics-enhanced', {
    metadata: { transcription_config: { language: 'th' } },
    results: [
      { type: 'word', start_time: 0, end_time: 0.4, alternatives: [{ content: 'สวัสดี', speaker: 'S1' }] },
      { type: 'word', start_time: 0.4, end_time: 0.8, alternatives: [{ content: 'ครับ', speaker: 'S1' }] },
    ],
  });
  assert.equal(speechmatics.text, 'สวัสดีครับ');
  assert.equal(speechmatics.language, 'th');

  const azure = normalizeAzure('azure-speech-batch', {
    durationInTicks: 50_000_000,
    recognizedPhrases: [{ offsetInTicks: 10_000_000, durationInTicks: 20_000_000, speaker: 1, locale: 'th-TH', nBest: [{ display: 'ทดสอบ' }] }],
  });
  assert.deepEqual(azure.segments[0], { start: 1, end: 3, speaker: 'S1', text: 'ทดสอบ' });
  assert.equal(azure.duration_seconds, 5);
  assert.equal(azure.language, 'th');

  const eleven = normalizeElevenLabs('elevenlabs-scribe-v2', {
    language_code: 'eng',
    words: [
      { text: 'Hello', start: 0, end: 0.3, type: 'word', speaker_id: 'speaker_0' },
      { text: ' ', start: 0.3, end: 0.35, type: 'spacing' },
      { text: 'team', start: 0.35, end: 0.6, type: 'word', speaker_id: 'speaker_0' },
    ],
  });
  assert.equal(eleven.text, 'Hello team');
  assert.equal(eleven.segments[0].speaker, 'S0');

  const gladia = normalizeGladia('gladia', { result: { metadata: { audio_duration: 9 }, transcription: { languages: ['th'], utterances: [{ start: 1, end: 2, speaker: 0, text: ' ทดลอง ' }] } } });
  assert.deepEqual(gladia.segments[0], { start: 1, end: 2, speaker: 'S1', text: 'ทดลอง' });

  const assembly = normalizeAssemblyAi('assemblyai-universal', { language_code: 'en_us', audio_duration: 4, utterances: [{ start: 1500, end: 3000, speaker: 'A', text: 'Hi' }] });
  assert.deepEqual(assembly.segments[0], { start: 1.5, end: 3, speaker: 'A', text: 'Hi' });
  assert.equal(assembly.language, 'en');

  const deepgram = normalizeDeepgram('deepgram-nova-3', { metadata: { duration: 3 }, results: { channels: [{ detected_language: 'en' }], utterances: [{ start: 0, end: 1, speaker: 1, transcript: 'yes' }] } });
  assert.deepEqual(deepgram.segments[0], { start: 0, end: 1, speaker: 'S2', text: 'yes' });
});

test('provider HTTP errors never carry URLs, bodies or keys', async () => {
  const { fetch } = fakeFetch([[/./, () => new Response(`bad ${SIGNED_URL} ${PROVIDER_KEY}`, { status: 400 })]]);
  await assert.rejects(
    requestJson(fetch, SIGNED_URL, { headers: { Authorization: PROVIDER_KEY } }, { label: 'speechmatics' }),
    (error: unknown) => error instanceof ProviderHttpError && error.message === 'speechmatics request failed with HTTP 400' && !error.retryable,
  );
});

test('OneDrive items map to media metadata and skip folders, deleted and non-media files', () => {
  const item = toMediaItem({
    id: 'A1', name: 'Weekly Meeting Recording.mp4', size: 10,
    file: { mimeType: 'video/mp4' }, parentReference: { id: 'P1', path: '/drive/root:/Transcribe/Meetings' }, video: { duration: 61_400 },
  });
  assert.deepEqual(item, {
    id: 'A1', name: 'Weekly Meeting Recording.mp4', parent_id: 'P1', folder_path: '/Transcribe/Meetings',
    mime_type: 'video/mp4', size_bytes: 10, duration_seconds: 61,
  });
  assert.equal(toMediaItem({ id: 'B', name: 'notes.md', file: { mimeType: 'text/markdown' } }), null);
  assert.equal(toMediaItem({ id: 'C', name: 'x.mp4', deleted: {}, file: { mimeType: 'video/mp4' } }), null);
  assert.equal(toMediaItem({ id: 'D', name: 'folder' }), null);
});

function oneDriveHandlers(deltaItems: unknown[]): Array<[RegExp, Handler]> {
  let refresh = 0;
  return [
    [/POST https:\/\/login\.microsoftonline\.com\/consumers\/oauth2\/v2\.0\/token/, () => ({ access_token: 'graph-access', refresh_token: `rotated-${++refresh}` })],
    [/GET .*\/delta\?token=latest/, () => ({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=CURSOR1' })],
    [/GET .*token=CURSOR1/, () => ({ value: deltaItems, '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=CURSOR2' })],
    [/GET .*token=CURSOR2/, () => ({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=CURSOR2' })],
    [/GET .*\/me\/drive\/items\/V1\?\$select=/, () => ({ id: 'V1', '@microsoft.graph.downloadUrl': SIGNED_URL })],
    [/GET .*\/me\/drive\/items\/P1\?\$select=/, () => ({ id: 'P1', name: 'Meetings', parentReference: { path: '/drive/root:/Transcribe' } })],
    [/PUT .*\/me\/drive\/items\/P1:/, () => ({ id: 'out' })],
  ];
}

// Like real delta responses, parentReference carries no path; the worker resolves it.
const MEETING_ITEM = {
  id: 'V1', name: 'CuteERP Weekly Meeting-Meeting Recording.mp4', size: 1000,
  file: { mimeType: 'video/mp4' }, parentReference: { id: 'P1' }, video: { duration: 3_600_000 },
};

test('pipeline runs OneDrive → Speechmatics → gateway summary → OneDrive without storing the signed URL', async () => {
  const smResult = {
    metadata: { transcription_config: { language: 'auto' } },
    results: [
      { type: 'word', start_time: 0, end_time: 0.5, alternatives: [{ content: 'สรุป', speaker: 'S1' }] },
      { type: 'word', start_time: 0.5, end_time: 1, alternatives: [{ content: 'งาน', speaker: 'S1' }] },
    ],
  };
  let polls = 0;
  const { fetch, calls } = fakeFetch([
    ...oneDriveHandlers([MEETING_ITEM]),
    [/POST https:\/\/asr\.api\.speechmatics\.com\/v2\/jobs$/, () => ({ id: 'SMJOB' })],
    [/GET .*\/v2\/jobs\/SMJOB\/transcript/, () => smResult],
    [/GET .*\/v2\/jobs\/SMJOB$/, () => ({ job: { status: ++polls > 1 ? 'done' : 'running', duration: 3600 } })],
    [/POST https:\/\/gateway\.test\/api\/ai\/generate/, () => ({ content: '## สรุปภาพรวม\nคุยเรื่องงาน [00:00:00]' })],
  ]);
  const kv = new MemoryKv();
  await kv.put(ONEDRIVE_REFRESH_KEY, 'initial-refresh');
  const logs: string[] = [];
  const env = { SPEECHMATICS_API_KEY: PROVIDER_KEY };
  const drive = new OneDrive({ clientId: 'client', kv, fetch, rootPath: '/Transcribe' });
  const written: OutputFile[] = [];
  const sink: OutputSink = { id: 'test', async write(_item: MediaItem, files: OutputFile[]) { written.push(...files); } };
  const deps = {
    source: drive, sink, kv, env, fetch,
    summarizer: createGatewaySummarizer({ baseUrl: 'https://gateway.test', token: GATEWAY_TOKEN, fetch }),
    log: (event: string, fields = {}) => logs.push(JSON.stringify({ event, ...fields })),
  };

  // Tick 1: first run starts from "now" and processes nothing.
  assert.equal((await runTick(deps)).discovered, 0);
  // Tick 2: the new meeting is routed and submitted with the signed URL.
  const second = await runTick(deps);
  assert.equal(second.discovered, 1);
  const submit = calls.find(call => call.method === 'POST' && call.url.endsWith('/v2/jobs'))!;
  const config = JSON.parse(String((submit.body as FormData).get('config')));
  assert.equal(config.fetch_data.url, SIGNED_URL);
  assert.equal(config.transcription_config.diarization, 'speaker');
  assert.equal(config.transcription_config.language, 'auto');
  // Ticks 3–5: pending poll, then transcribed, then summarized and written.
  await runTick(deps);
  await runTick(deps);
  const last = await runTick(deps);
  assert.equal(last.done, 1);
  assert.equal(last.active, 0);

  const job = JSON.parse((await kv.get('job:V1'))!) as JobRecord;
  assert.equal(job.status, 'done');
  assert.equal(job.item.folder_path, '/Transcribe/Meetings');
  assert.equal(job.decision.content_kind.reasons[0], 'folder matches meeting');
  assert.equal(job.provider_id, 'speechmatics-enhanced');
  assert.deepEqual(written.map(file => file.name), [
    'CuteERP Weekly Meeting-Meeting Recording.summary.md',
    'CuteERP Weekly Meeting-Meeting Recording.transcript.srt',
    'CuteERP Weekly Meeting-Meeting Recording.transcript.json',
  ]);
  assert.match(written[0].content, /สรุปงาน|สรุปภาพรวม/);
  const gatewayCall = calls.find(call => call.url.includes('/api/ai/generate'))!;
  assert.equal((gatewayCall.body as any).route, 'media-summary-meeting');
  assert.equal((gatewayCall.body as any).privacy_class, 'internal');

  // Rotated refresh token persisted; no secret or signed URL in state, logs or outputs.
  assert.match((await kv.get(ONEDRIVE_REFRESH_KEY))!, /^rotated-/);
  const everything = JSON.stringify([...kv.data.entries()]) + logs.join('\n') + JSON.stringify(written);
  for (const marker of ['SIGNED-DOWNLOAD-MARKER', GATEWAY_TOKEN, PROVIDER_KEY]) assert.equal(everything.includes(marker), false, marker);
});

test('a rejected provider falls back to the next ranked provider', async () => {
  // [th] routes to the Thai list, where Speechmatics ranks above ElevenLabs.
  const { fetch } = fakeFetch([
    ...oneDriveHandlers([{ ...MEETING_ITEM, name: 'Weekly Meeting [th].mp4' }]),
    [/POST https:\/\/asr\.api\.speechmatics\.com/, () => new Response('{}', { status: 400 })],
    [/POST https:\/\/api\.elevenlabs\.io\/v1\/speech-to-text/, () => ({ language_code: 'tha', words: [{ text: 'ok', start: 0, end: 1, type: 'word', speaker_id: 'speaker_0' }] })],
  ]);
  const kv = new MemoryKv();
  await kv.put(ONEDRIVE_REFRESH_KEY, 'initial-refresh');
  const env = { SPEECHMATICS_API_KEY: 'k', ELEVENLABS_API_KEY: 'k' };
  const deps = {
    source: new OneDrive({ clientId: 'client', kv, fetch, rootPath: '/Transcribe' }),
    sink: { id: 'noop', async write() {} },
    summarizer: { summarize: async () => 'summary' },
    kv, env, fetch,
  };
  await runTick(deps);
  await runTick(deps); // speechmatics 400 → fallback queued
  let job = JSON.parse((await kv.get('job:V1'))!) as JobRecord;
  assert.equal(job.status, 'queued');
  assert.match(job.error || '', /speechmatics-enhanced request failed with HTTP 400/);
  assert.equal(job.provider_id, 'elevenlabs-scribe-v2');
  await runTick(deps); // elevenlabs answers synchronously
  job = JSON.parse((await kv.get('job:V1'))!) as JobRecord;
  assert.equal(job.status, 'transcribed');
});

test('long transcripts are summarized chunk by chunk before the final pass', async () => {
  const prompts: string[] = [];
  const { fetch } = fakeFetch([[/api\/ai\/generate/, call => {
    prompts.push((call.body as any).prompt_version);
    return { content: 'โน้ต' };
  }]]);
  const segments = Array.from({ length: 40 }, (_, index) => ({ start: index * 10, end: index * 10 + 9, speaker: 'S1', text: 'ข้อความยาว'.repeat(10) }));
  const transcript: Transcript = { provider_id: 'x', language: 'th', duration_seconds: 400, text: '', segments };
  const summarizer = createGatewaySummarizer({ baseUrl: 'https://gateway.test', token: 't', fetch, chunkChars: 2_000 });
  await summarizer.summarize({ profile: 'meeting-minutes', gateway_route: 'media-summary-meeting', prompt_version: 'meeting-minutes-v1', gateway_profile: 'quality', file_name: 'a.mp4', transcript });
  assert.ok(prompts.filter(version => version.endsWith('-chunk')).length >= 2);
  assert.equal(prompts[prompts.length - 1], 'meeting-minutes-v1');
  assert.deepEqual(splitLines('a\nb\nc', 3), ['a\nb', 'c']);
});

test('configuration reports names only and state selection is explicit', () => {
  assert.deepEqual(configurationProblems({}), ['ONEDRIVE_CLIENT_ID is not set', 'AI_GATEWAY_URL is not set', 'AI_GATEWAY_TOKEN is not set']);
  const platform = new MemoryKv();
  const noFetch: FetchLike = async () => new Response('{}');
  assert.equal(selectKv({}, noFetch, platform), platform);
  assert.throws(() => selectKv({ MEDIA_STATE: 'upstash' }, noFetch, platform), /UPSTASH_REDIS_REST_URL is not set/);
  assert.throws(() => selectKv({}, noFetch), /UPSTASH_REDIS_REST_URL is not set/);
});

test('a job left outside the active set is recovered and a held lock skips the tick', async () => {
  const { fetch } = fakeFetch([
    ...oneDriveHandlers([MEETING_ITEM]),
    [/POST https:\/\/asr\.api\.speechmatics\.com\/v2\/jobs$/, () => ({ id: 'SMJOB' })],
  ]);
  const kv = new MemoryKv();
  await kv.put(ONEDRIVE_REFRESH_KEY, 'initial-refresh');
  await kv.put('onedrive:delta_link', 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=CURSOR1');
  const deps = {
    source: new OneDrive({ clientId: 'client', kv, fetch, rootPath: '/Transcribe' }),
    sink: { id: 'noop', async write() {} },
    summarizer: { summarize: async () => 'summary' },
    kv, env: { SPEECHMATICS_API_KEY: 'k' }, fetch,
    maxJobsPerTick: 0,
  };
  await runTick(deps);
  // Simulate a crash that lost the active set after the job was saved.
  await kv.delete('jobs:active');
  await kv.put('onedrive:delta_link', 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=CURSOR1');
  const recovered = await runTick({ ...deps, maxJobsPerTick: 5 });
  assert.equal(recovered.discovered, 0);
  assert.equal(JSON.parse((await kv.get('job:V1'))!).status, 'submitted');

  await kv.put('lock:tick', '1');
  assert.equal((await runTick(deps)).skipped_locked, true);
});

test('Thai is scored by CER that ignores word spaces; English by WER', async () => {
  const { errorRatePct, metricFor } = await import('../core/metrics.js');
  assert.equal(metricFor('th'), 'cer');
  assert.equal(metricFor('mixed'), 'cer');
  assert.equal(metricFor('en'), 'wer');
  assert.equal(errorRatePct('สวัสดีครับ ทุกคน', 'สวัสดี ครับทุกคน', 'cer'), 0);
  assert.equal(errorRatePct('สวัสดีครับ', 'สวัสดีคับ', 'cer'), 10); // 1 deletion over 10 code points
  assert.equal(errorRatePct('Hello, team.', 'hello team', 'wer'), 0);
  assert.equal(errorRatePct('the quick brown fox', 'the quick fox', 'wer'), 25);
});

test('transcribeAndWait polls async providers until completion', async () => {
  const { transcribeAndWait } = await import('../core/transcribe.js');
  let polls = 0;
  const transcript: Transcript = { provider_id: 'p', language: 'th', duration_seconds: 1, text: 'ok', segments: [] };
  const adapter = {
    id: 'p',
    submit: async () => ({ kind: 'job' as const, jobId: 'J' }),
    poll: async () => (++polls < 3 ? { state: 'pending' as const } : { state: 'completed' as const, transcript }),
  };
  const result = await transcribeAndWait(adapter, { mediaUrl: 'u', model: 'm', language: 'th', diarization: false }, { sleep: async () => undefined });
  assert.equal(result.text, 'ok');
  assert.equal(polls, 3);
});

test('eval results become own_eval and change the routed provider', async () => {
  const { applyOwnEval, parseArgs, summarizeEval } = await import('../entry/tools.js');
  const { DEFAULT_MEDIA_ROUTING_REGISTRY, decideMediaRoute } = await import('../vendor/media_router.js');
  const rows = summarizeEval([
    { provider_id: 'speechmatics-enhanced', language: 'th', error_rate_pct: 9, duration_seconds: 1800, latency_s: 60 },
    { provider_id: 'speechmatics-enhanced', language: 'th', error_rate_pct: 11, duration_seconds: 1800, latency_s: 80 },
    { provider_id: 'gladia', language: 'th', error_rate_pct: 6, duration_seconds: 3600, latency_s: 40 },
    { provider_id: 'gladia', language: 'th', error_rate_pct: null, duration_seconds: null, latency_s: 5 },
  ], DEFAULT_MEDIA_ROUTING_REGISTRY);
  assert.deepEqual(rows.map(row => [row.provider_id, row.error_rate_pct, row.samples, row.failures]), [
    ['gladia', 6, 1, 1],
    ['speechmatics-enhanced', 10, 2, 0],
  ]);
  assert.equal(rows[1].est_cost_usd, 0.4);
  assert.equal(rows[1].metric, 'cer');

  const registry = applyOwnEval(DEFAULT_MEDIA_ROUTING_REGISTRY, rows, '2026-10-08');
  assert.deepEqual(registry.providers['gladia'].own_eval, { evaluated_at: '2026-10-08', sample_count: 1, wer_pct: { th: 6 }, metric: { th: 'cer' } });
  assert.equal(DEFAULT_MEDIA_ROUTING_REGISTRY.providers['gladia'].own_eval, null, 'input registry is not mutated');
  const decision = decideMediaRoute({ file_name: 'x [clip] [th].mp4' }, {
    registry, env: { SPEECHMATICS_API_KEY: 'k', GLADIA_API_KEY: 'k' }, now: new Date('2026-10-09T00:00:00Z'),
  });
  assert.equal(decision.stt?.provider_id, 'gladia');
  assert.equal(decision.stt?.selected_by, 'own_eval');

  assert.deepEqual(parseArgs(['--url', 'u', '--write', '--name', 'a b.mp4']), { url: 'u', write: true, name: 'a b.mp4' });
});
