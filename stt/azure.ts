import { requestJson } from '../core/http.js';
import { fullText, speakerLabel } from '../core/transcript.js';
import type { FetchLike, SttAdapter, SttPollResult, SttRequest, SttSubmitResult, Transcript, TranscriptSegment } from '../core/types.js';

const TICKS_PER_SECOND = 10_000_000;
const LOCALES: Record<string, string> = { th: 'th-TH', en: 'en-US' };

interface AzurePhrase {
  offsetInTicks: number;
  durationInTicks: number;
  speaker?: number;
  locale?: string;
  nBest?: Array<{ display?: string }>;
}

export function normalizeAzure(providerId: string, body: { durationInTicks?: number; recognizedPhrases?: AzurePhrase[] }): Transcript {
  const segments: TranscriptSegment[] = [];
  const locales = new Map<string, number>();
  for (const phrase of body.recognizedPhrases || []) {
    const text = phrase.nBest?.[0]?.display?.trim();
    if (!text) continue;
    const start = phrase.offsetInTicks / TICKS_PER_SECOND;
    segments.push({ start, end: start + phrase.durationInTicks / TICKS_PER_SECOND, speaker: speakerLabel(phrase.speaker === undefined ? null : phrase.speaker - 1), text });
    if (phrase.locale) locales.set(phrase.locale, (locales.get(phrase.locale) || 0) + 1);
  }
  segments.sort((a, b) => a.start - b.start);
  const dominant = [...locales.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    provider_id: providerId,
    language: dominant ? dominant.slice(0, 2) : null,
    duration_seconds: typeof body.durationInTicks === 'number' ? body.durationInTicks / TICKS_PER_SECOND : null,
    text: fullText(segments),
    segments,
  };
}

/**
 * Azure AI Speech batch transcription. The service fetches contentUrls itself.
 * The REST API version is configurable because Azure revises it over time.
 */
export function createAzureSpeechAdapter(options: {
  id: string;
  apiKey: string;
  region?: string;
  endpoint?: string;
  apiVersion?: string;
  fetch: FetchLike;
}): SttAdapter {
  const endpoint = (options.endpoint || `https://${options.region}.api.cognitive.microsoft.com`).replace(/\/$/, '');
  const version = options.apiVersion || '2024-11-15';
  const headers = { 'Ocp-Apim-Subscription-Key': options.apiKey, 'Content-Type': 'application/json' };
  const label = options.id;
  const url = (path: string) => `${endpoint}/speechtotext/${path}${path.includes('?') ? '&' : '?'}api-version=${version}`;
  return {
    id: options.id,
    async submit(request: SttRequest): Promise<SttSubmitResult> {
      const body = {
        displayName: 'solo-media-worker',
        contentUrls: [request.mediaUrl],
        locale: request.language ? LOCALES[request.language] : 'th-TH',
        properties: {
          wordLevelTimestampsEnabled: true,
          punctuationMode: 'DictatedAndAutomatic',
          timeToLiveHours: 12,
          ...(request.diarization ? { diarizationEnabled: true } : {}),
          ...(request.language ? {} : { languageIdentification: { candidateLocales: ['th-TH', 'en-US'] } }),
        },
      };
      const created = await requestJson<{ self: string }>(
        options.fetch, url('transcriptions:submit'), { method: 'POST', headers, body: JSON.stringify(body) }, { label },
      );
      const jobId = created.self.split('?')[0].split('/').pop();
      if (!jobId) throw new Error(`${label} returned no transcription id`);
      return { kind: 'job', jobId };
    },
    async poll(jobId: string): Promise<SttPollResult> {
      const id = encodeURIComponent(jobId);
      const status = await requestJson<{ status: string }>(options.fetch, url(`transcriptions/${id}`), { headers }, { label });
      if (status.status === 'Failed') return { state: 'failed', reason: 'transcription Failed' };
      if (status.status !== 'Succeeded') return { state: 'pending' };
      const files = await requestJson<{ values: Array<{ kind: string; links: { contentUrl: string } }> }>(
        options.fetch, url(`transcriptions/${id}/files`), { headers }, { label },
      );
      const result = files.values.find(file => file.kind === 'Transcription');
      if (!result) return { state: 'failed', reason: 'no transcription file' };
      // contentUrl is a pre-signed URL: send it without the subscription key.
      const body = await requestJson<any>(options.fetch, result.links.contentUrl, {}, { label, timeoutMs: 120_000 });
      return { state: 'completed', transcript: normalizeAzure(options.id, body) };
    },
  };
}
