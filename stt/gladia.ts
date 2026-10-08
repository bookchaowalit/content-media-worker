import { requestJson } from '../core/http.js';
import { fullText, speakerLabel } from '../core/transcript.js';
import type { FetchLike, SttAdapter, SttPollResult, SttRequest, SttSubmitResult, Transcript } from '../core/types.js';

const DEFAULT_BASE = 'https://api.gladia.io/v2';

export function normalizeGladia(providerId: string, body: any): Transcript {
  const transcription = body?.result?.transcription || {};
  const segments = (transcription.utterances || [])
    .filter((utterance: any) => typeof utterance.text === 'string' && utterance.text.trim())
    .map((utterance: any) => ({ start: utterance.start, end: utterance.end, speaker: speakerLabel(utterance.speaker), text: utterance.text.trim() }));
  return {
    provider_id: providerId,
    language: transcription.languages?.[0] ?? null,
    duration_seconds: body?.result?.metadata?.audio_duration ?? null,
    text: segments.length ? fullText(segments) : (transcription.full_transcript || ''),
    segments,
  };
}

/** Gladia pre-recorded API with native code-switching for mixed Thai/English. */
export function createGladiaAdapter(options: { id: string; apiKey: string; fetch: FetchLike; baseUrl?: string }): SttAdapter {
  const base = (options.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const headers = { 'x-gladia-key': options.apiKey, 'Content-Type': 'application/json' };
  const label = options.id;
  return {
    id: options.id,
    async submit(request: SttRequest): Promise<SttSubmitResult> {
      const body = {
        audio_url: request.mediaUrl,
        diarization: request.diarization,
        language_config: request.language
          ? { languages: [request.language], code_switching: false }
          : { languages: ['th', 'en'], code_switching: true },
      };
      const created = await requestJson<{ id: string }>(options.fetch, `${base}/pre-recorded`, { method: 'POST', headers, body: JSON.stringify(body) }, { label });
      return { kind: 'job', jobId: created.id };
    },
    async poll(jobId: string): Promise<SttPollResult> {
      const body = await requestJson<any>(options.fetch, `${base}/pre-recorded/${encodeURIComponent(jobId)}`, { headers }, { label });
      if (body.status === 'error') return { state: 'failed', reason: `job error ${String(body.error_code ?? '').slice(0, 16)}`.trim() };
      if (body.status !== 'done') return { state: 'pending' };
      return { state: 'completed', transcript: normalizeGladia(options.id, body) };
    },
  };
}
