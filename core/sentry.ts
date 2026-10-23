/**
 * Sentry settings shared by the runtime entries (only entry/node.ts wires it today).
 * Errors only: no tracing, no breadcrumbs, no request data. Events are rebuilt
 * from an allowlist (no tags; messages only if they are the app's own) so nothing that can carry media URLs, OneDrive or provider
 * tokens, transcripts or host names leaves the process. Off when SENTRY_DSN is unset.
 */

const EVENT_KEYS = new Set(['event_id', 'timestamp', 'platform', 'level', 'logger', 'release', 'environment', 'exception', 'message', 'sdk', 'contexts']);
const CONTEXT_KEYS = new Set(['runtime', 'os']);
const FRAME_KEYS = new Set(['filename', 'function', 'module', 'lineno', 'colno', 'in_app']);

export const REDACTED = '[redacted]';

const ID = '[a-z0-9_.-]{1,40}';
/** The app's own error messages (core/, stt/, summarize/, sources/, entry/). Anything else is redacted. */
const APP_MESSAGES: readonly RegExp[] = [
  new RegExp(`^${ID} request failed with HTTP \\d{3}$`),
  new RegExp(`^${ID} request timed out$`),
  /^[A-Z][A-Z0-9_]{1,60} is not set$/,
  /^AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT is not set$/,
  new RegExp(`^MEDIA_(STATE|SINK)=${ID} is not available on this runtime$`),
  new RegExp(`^${ID} returned no transcription id$`),
  new RegExp(`^${ID} did not finish within \\d{1,4} minutes$`),
  new RegExp(`^unknown summary profile ${ID}$`),
  /^transcript is too long to summarize within the configured chunk size$/,
  /^OneDrive is not linked; run the login command first$/,
  /^OneDrive returned no download URL$/,
  /^device login failed: [a-z0-9_]{1,40}$/,
  /^device login expired$/,
  new RegExp(`^no adapter for vendor ${ID}$`),
];

/** Keeps a message only if it is one of the app's own error messages; else "[redacted]". */
export function safeMessage(message: unknown): string {
  return typeof message === 'string' && APP_MESSAGES.some((pattern) => pattern.test(message)) ? message : REDACTED;
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
    const mechanism = (value.mechanism ?? {}) as { type?: unknown; source?: unknown };
    // Linked cause errors keep their type only.
    if (mechanism.type === 'chained' || mechanism.source !== undefined) delete value.value;
    else value.value = safeMessage(value.value);
    if (value.mechanism !== undefined) value.mechanism = { type: mechanism.type, handled: (value.mechanism as { handled?: unknown }).handled };
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
