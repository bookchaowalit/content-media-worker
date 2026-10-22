/**
 * Sentry settings shared by the runtime entries (only entry/node.ts wires it today).
 * Errors only: no tracing, no breadcrumbs, no request data. Events are rebuilt
 * from an allowlist so nothing that can carry media URLs, OneDrive or provider
 * tokens, transcripts or host names leaves the process. Off when SENTRY_DSN is unset.
 */

const EVENT_KEYS = new Set(['event_id', 'timestamp', 'platform', 'level', 'logger', 'release', 'environment', 'exception', 'message', 'tags', 'sdk', 'contexts']);
const CONTEXT_KEYS = new Set(['runtime', 'os']);
const FRAME_KEYS = new Set(['filename', 'function', 'module', 'lineno', 'colno', 'in_app']);

/** Same rule as errorSummary in core/http.ts: short plain messages pass, anything else is replaced. */
export function safeMessage(message: unknown): string {
  return typeof message === 'string' && /^[\w .:/-]{1,120}$/.test(message) ? message : 'unexpected error';
}

type Frame = Record<string, unknown>;
type ExceptionValue = { type?: unknown; value?: unknown; mechanism?: unknown; stacktrace?: { frames?: Frame[] } };
export type SentryLikeEvent = Record<string, unknown> & {
  message?: unknown;
  contexts?: Record<string, unknown>;
  exception?: { values?: ExceptionValue[] };
};

export function scrubEvent<T extends object>(input: T): T {
  const event = input as SentryLikeEvent;
  for (const key of Object.keys(event)) if (!EVENT_KEYS.has(key)) delete event[key];
  if (event.message !== undefined) event.message = safeMessage(event.message);
  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) if (!CONTEXT_KEYS.has(key)) delete event.contexts[key];
  }
  for (const value of event.exception?.values ?? []) {
    value.value = safeMessage(value.value);
    for (const frame of value.stacktrace?.frames ?? []) {
      for (const key of Object.keys(frame)) if (!FRAME_KEYS.has(key)) delete frame[key];
    }
  }
  return input;
}

export function sentryOptions(env: { SENTRY_DSN?: string; SENTRY_ENVIRONMENT?: string }) {
  const dsn = (env.SENTRY_DSN || '').trim() || undefined;
  return {
    dsn,
    enabled: Boolean(dsn),
    environment: env.SENTRY_ENVIRONMENT || 'production',
    sendDefaultPii: false,
    tracesSampleRate: undefined,
    tracePropagationTargets: [] as string[],
    maxBreadcrumbs: 0,
    beforeSend: scrubEvent,
  };
}
