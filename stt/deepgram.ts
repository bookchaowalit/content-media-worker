import { ProviderHttpError, ProviderTimeoutError, requestJson } from '../core/http.js';
import { fullText, speakerLabel } from '../core/transcript.js';
import type { FetchLike, SttAdapter, SttRequest, SttSubmitResult, Transcript } from '../core/types.js';

const DEFAULT_BASE = 'https://api.deepgram.com/v1';

export function normalizeDeepgram(providerId: string, body: any): Transcript {
  const segments = (body?.results?.utterances || [])
    .filter((utterance: any) => typeof utterance.transcript === 'string' && utterance.transcript.trim())
    .map((utterance: any) => ({ start: utterance.start, end: utterance.end, speaker: speakerLabel(utterance.speaker), text: utterance.transcript.trim() }));
  const channel = body?.results?.channels?.[0];
  return {
    provider_id: providerId,
    language: channel?.detected_language ? String(channel.detected_language).slice(0, 2) : null,
    duration_seconds: body?.metadata?.duration ?? null,
    text: segments.length ? fullText(segments) : (channel?.alternatives?.[0]?.transcript || ''),
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

/** Deepgram pre-recorded API answers synchronously and fetches the URL itself. */
export function createDeepgramAdapter(options: { id: string; apiKey: string; fetch: FetchLike; baseUrl?: string; timeoutMs?: number }): SttAdapter {
  const base = (options.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  return {
    id: options.id,
    async submit(request: SttRequest): Promise<SttSubmitResult> {
      const params = new URLSearchParams({ model: request.model, smart_format: 'true', punctuate: 'true', utterances: 'true', diarize: String(request.diarization) });
      if (request.language) params.set('language', request.language);
      else params.set('detect_language', 'true');
      const body = await nonRetryableOnTimeout(options.id, () => requestJson<any>(
        options.fetch, `${base}/listen?${params}`,
        { method: 'POST', headers: { Authorization: `Token ${options.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: request.mediaUrl }) },
        { label: options.id, timeoutMs: options.timeoutMs ?? 600_000 },
      ));
      return { kind: 'transcript', transcript: normalizeDeepgram(options.id, body) };
    },
    async poll() {
      return { state: 'failed', reason: 'synchronous provider has no jobs' };
    },
  };
}
