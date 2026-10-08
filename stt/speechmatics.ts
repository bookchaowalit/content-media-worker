import { requestJson } from '../core/http.js';
import { fullText, segmentWords, speakerLabel, type WordToken } from '../core/transcript.js';
import type { FetchLike, SttAdapter, SttPollResult, SttRequest, SttSubmitResult, Transcript } from '../core/types.js';

const DEFAULT_BASE = 'https://asr.api.speechmatics.com/v2';

interface SpeechmaticsResult {
  type: string;
  start_time: number;
  end_time: number;
  alternatives?: Array<{ content: string; speaker?: string; language?: string }>;
}

export function normalizeSpeechmatics(providerId: string, body: { metadata?: any; results?: SpeechmaticsResult[]; job?: any }): Transcript {
  const words: WordToken[] = [];
  for (const result of body.results || []) {
    const alternative = result.alternatives?.[0];
    if (!alternative?.content) continue;
    words.push({ start: result.start_time, end: result.end_time, speaker: speakerLabel(alternative.speaker), text: alternative.content });
  }
  const segments = segmentWords(words);
  return {
    provider_id: providerId,
    language: body.metadata?.transcription_config?.language ?? null,
    duration_seconds: typeof body.job?.duration === 'number' ? body.job.duration : null,
    text: fullText(segments),
    segments,
  };
}

/** Speechmatics batch API: the job fetches the media itself via fetch_data.url. */
export function createSpeechmaticsAdapter(options: { id: string; apiKey: string; fetch: FetchLike; baseUrl?: string }): SttAdapter {
  const base = (options.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const auth = { Authorization: `Bearer ${options.apiKey}` };
  const label = options.id;
  return {
    id: options.id,
    async submit(request: SttRequest): Promise<SttSubmitResult> {
      const config: Record<string, unknown> = {
        type: 'transcription',
        transcription_config: {
          language: request.language ?? 'auto',
          operating_point: request.model === 'standard' ? 'standard' : 'enhanced',
          ...(request.diarization ? { diarization: 'speaker' } : {}),
        },
        fetch_data: { url: request.mediaUrl },
        ...(request.language ? {} : { language_identification_config: { expected_languages: ['th', 'en'] } }),
      };
      const form = new FormData();
      form.append('config', JSON.stringify(config));
      const created = await requestJson<{ id: string }>(options.fetch, `${base}/jobs`, { method: 'POST', headers: auth, body: form }, { label });
      return { kind: 'job', jobId: created.id };
    },
    async poll(jobId: string): Promise<SttPollResult> {
      const status = await requestJson<{ job: { status: string; duration?: number } }>(
        options.fetch, `${base}/jobs/${encodeURIComponent(jobId)}`, { headers: auth }, { label },
      );
      const state = status.job?.status;
      if (state === 'rejected' || state === 'deleted' || state === 'expired') return { state: 'failed', reason: `job ${state}` };
      if (state !== 'done') return { state: 'pending' };
      const body = await requestJson<any>(
        options.fetch, `${base}/jobs/${encodeURIComponent(jobId)}/transcript?format=json-v2`, { headers: auth }, { label, timeoutMs: 120_000 },
      );
      return { state: 'completed', transcript: normalizeSpeechmatics(options.id, { ...body, job: status.job }) };
    },
  };
}
