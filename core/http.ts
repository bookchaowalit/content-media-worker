import type { FetchLike } from './types.js';

/**
 * Provider errors carry the provider label and HTTP status only. Response
 * bodies, request URLs and headers are never copied into the message because
 * they can contain signed media URLs or credentials.
 */
export class ProviderHttpError extends Error {
  constructor(readonly label: string, readonly status: number, readonly retryable: boolean) {
    super(`${label} request failed with HTTP ${status}`);
  }
}

export class ProviderTimeoutError extends Error {
  constructor(readonly label: string) {
    super(`${label} request timed out`);
  }
}

export interface RequestOptions {
  label: string;
  timeoutMs?: number;
}

export async function request(fetchFn: FetchLike, url: string, init: RequestInit, options: RequestOptions): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      // Drain the body so the connection can be reused, without reading it into errors.
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderHttpError(options.label, response.status, response.status === 429 || response.status >= 500);
    }
    return response;
  } catch (error) {
    if (error instanceof ProviderHttpError) throw error;
    if (controller.signal.aborted) throw new ProviderTimeoutError(options.label);
    throw new ProviderHttpError(options.label, 0, true);
  } finally {
    clearTimeout(timer);
  }
}

export async function requestJson<T>(fetchFn: FetchLike, url: string, init: RequestInit, options: RequestOptions): Promise<T> {
  const response = await request(fetchFn, url, init, options);
  try {
    return (await response.json()) as T;
  } catch {
    throw new ProviderHttpError(options.label, response.status, false);
  }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderTimeoutError) return true;
  if (error instanceof ProviderHttpError) return error.retryable;
  return false;
}

/** Safe, fixed description of an error for logs and job records. */
export function errorSummary(error: unknown): string {
  if (error instanceof ProviderHttpError || error instanceof ProviderTimeoutError) return error.message;
  if (error instanceof Error && /^[\w .:/-]{1,120}$/.test(error.message)) return error.message;
  return 'unexpected error';
}
