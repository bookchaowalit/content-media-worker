import { requestJson } from '../core/http.js';
import { fullText, speakerLabel } from '../core/transcript.js';
import type { FetchLike, SttAdapter, SttPollResult, SttRequest, SttSubmitResult, Transcript } from '../core/types.js';

const DEFAULT_BASE = 'https://api.assemblyai.com/v2';

export function normalizeAssemblyAi(providerId: string, body: any): Transcript {
  const segments = (body.utterances || [])
    .filter((utterance: any) => typeof utterance.text === 'string' && utterance.text.trim())
    .map((utterance: any) => ({ start: utterance.start / 1000, end: utterance.end / 1000, speaker: speakerLabel(utterance.speaker), text: utterance.text.trim() }));
  return {
    provider_id: providerId,
    language: typeof body.language_code === 'string' ? body.language_code.slice(0, 2) : null,
    duration_seconds: typeof body.audio_duration === 'number' ? body.audio_duration : null,
    text: segments.length ? fullText(segments) : (body.text || ''),
    segments,
  };
}

export function createAssemblyAiAdapter(options: { id: string; apiKey: string; fetch: FetchLike; baseUrl?: string }): SttAdapter {
  const base = (options.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const headers = { authorization: options.apiKey, 'Content-Type': 'application/json' };
  const label = options.id;
  return {
    id: options.id,
    async submit(request: SttRequest): Promise<SttSubmitResult> {
      const body = {
        audio_url: request.mediaUrl,
        speech_model: request.model,
        speaker_labels: request.diarization,
        ...(request.language ? { language_code: request.language } : { language_detection: true }),
      };
      const created = await requestJson<{ id: string }>(options.fetch, `${base}/transcript`, { method: 'POST', headers, body: JSON.stringify(body) }, { label });
      return { kind: 'job', jobId: created.id };
    },
    async poll(jobId: string): Promise<SttPollResult> {
      const body = await requestJson<any>(options.fetch, `${base}/transcript/${encodeURIComponent(jobId)}`, { headers }, { label });
      if (body.status === 'error') return { state: 'failed', reason: 'transcript error' };
      if (body.status !== 'completed') return { state: 'pending' };
      return { state: 'completed', transcript: normalizeAssemblyAi(options.id, body) };
    },
  };
}
