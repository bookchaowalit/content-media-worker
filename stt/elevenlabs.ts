import { ProviderHttpError, ProviderTimeoutError, requestJson } from '../core/http.js';
import { fullText, segmentWords, speakerLabel, type WordToken } from '../core/transcript.js';
import type { FetchLike, SttAdapter, SttRequest, SttSubmitResult, Transcript } from '../core/types.js';

const DEFAULT_BASE = 'https://api.elevenlabs.io/v1';

export function normalizeElevenLabs(providerId: string, body: {
  language_code?: string;
  text?: string;
  words?: Array<{ text: string; start: number; end: number; type?: string; speaker_id?: string }>;
}): Transcript {
  const words: WordToken[] = (body.words || [])
    .filter(word => (word.type ?? 'word') === 'word' && word.text.trim())
    .map(word => ({ start: word.start, end: word.end, speaker: speakerLabel(word.speaker_id), text: word.text }));
  const segments = segmentWords(words);
  const last = body.words?.[body.words.length - 1];
  return {
    provider_id: providerId,
    language: body.language_code ? body.language_code.slice(0, 2) : null,
    duration_seconds: last ? last.end : null,
    text: segments.length ? fullText(segments) : (body.text || ''),
    segments,
  };
}

/**
 * A synchronous provider may still finish (and bill) a request after our
 * timeout, so a timeout must not trigger automatic resubmission to it.
 */
async function nonRetryableOnTimeout<T>(label: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ProviderTimeoutError) throw new ProviderHttpError(label, 408, false);
    throw error;
  }
}

/** ElevenLabs Scribe answers synchronously; cloud_storage_url makes it fetch the media. */
export function createElevenLabsAdapter(options: { id: string; apiKey: string; fetch: FetchLike; baseUrl?: string; timeoutMs?: number }): SttAdapter {
  const base = (options.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  return {
    id: options.id,
    async submit(request: SttRequest): Promise<SttSubmitResult> {
      const form = new FormData();
      form.append('model_id', request.model);
      form.append('cloud_storage_url', request.mediaUrl);
      form.append('diarize', String(request.diarization));
      form.append('timestamps_granularity', 'word');
      form.append('tag_audio_events', 'false');
      if (request.language) form.append('language_code', request.language);
      const body = await nonRetryableOnTimeout(options.id, () => requestJson<any>(
        options.fetch, `${base}/speech-to-text`,
        { method: 'POST', headers: { 'xi-api-key': options.apiKey }, body: form },
        { label: options.id, timeoutMs: options.timeoutMs ?? 600_000 },
      ));
      return { kind: 'transcript', transcript: normalizeElevenLabs(options.id, body) };
    },
    async poll() {
      return { state: 'failed', reason: 'synchronous provider has no jobs' };
    },
  };
}
