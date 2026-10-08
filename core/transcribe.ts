import type { SttAdapter, SttRequest, Transcript } from './types.js';

export interface TranscribeOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onPending?: (elapsedMs: number) => void;
}

/**
 * Submit and wait for one transcript. Used by the one-off `transcribe` and
 * `eval` commands; the scheduled pipeline persists state between ticks instead.
 */
export async function transcribeAndWait(adapter: SttAdapter, request: SttRequest, options: TranscribeOptions = {}): Promise<Transcript> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const interval = options.pollIntervalMs ?? 15_000;
  const timeout = options.timeoutMs ?? 90 * 60_000;
  const submitted = await adapter.submit(request);
  if (submitted.kind === 'transcript') return submitted.transcript;
  const started = Date.now();
  for (;;) {
    const elapsed = Date.now() - started;
    if (elapsed > timeout) throw new Error(`${adapter.id} did not finish within ${Math.round(timeout / 60_000)} minutes`);
    await sleep(interval);
    const outcome = await adapter.poll(submitted.jobId);
    if (outcome.state === 'completed') return outcome.transcript;
    if (outcome.state === 'failed') throw new Error(`${adapter.id} failed: ${outcome.reason}`);
    options.onPending?.(Date.now() - started);
  }
}
