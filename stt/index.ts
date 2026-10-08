import type { ProviderEntry } from '../../api/media_router.js';
import type { FetchLike, SttAdapter } from '../core/types.js';
import { createAssemblyAiAdapter } from './assemblyai.js';
import { createAzureSpeechAdapter } from './azure.js';
import { createDeepgramAdapter } from './deepgram.js';
import { createElevenLabsAdapter } from './elevenlabs.js';
import { createGladiaAdapter } from './gladia.js';
import { createSpeechmaticsAdapter } from './speechmatics.js';

export type WorkerEnv = Record<string, string | undefined>;

/**
 * Builds the adapter for a registry provider. Adding a vendor means one adapter
 * file plus one case here; the router and pipeline stay unchanged.
 */
export function createSttAdapter(id: string, provider: ProviderEntry, env: WorkerEnv, fetchFn: FetchLike): SttAdapter {
  const apiKey = (env[provider.credential_env] || '').trim();
  if (!apiKey) throw new Error(`${provider.credential_env} is not set`);
  switch (provider.vendor) {
    case 'speechmatics':
      return createSpeechmaticsAdapter({ id, apiKey, fetch: fetchFn, baseUrl: env.SPEECHMATICS_BASE_URL });
    case 'microsoft':
      if (!env.AZURE_SPEECH_REGION && !env.AZURE_SPEECH_ENDPOINT) throw new Error('AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT is not set');
      return createAzureSpeechAdapter({
        id,
        apiKey,
        region: env.AZURE_SPEECH_REGION,
        endpoint: env.AZURE_SPEECH_ENDPOINT,
        apiVersion: env.AZURE_SPEECH_API_VERSION,
        fetch: fetchFn,
      });
    case 'elevenlabs':
      return createElevenLabsAdapter({ id, apiKey, fetch: fetchFn });
    case 'gladia':
      return createGladiaAdapter({ id, apiKey, fetch: fetchFn });
    case 'assemblyai':
      return createAssemblyAiAdapter({ id, apiKey, fetch: fetchFn });
    case 'deepgram':
      return createDeepgramAdapter({ id, apiKey, fetch: fetchFn });
    default:
      throw new Error(`no adapter for vendor ${provider.vendor}`);
  }
}
