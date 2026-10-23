import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeMessage, scrubEvent, sentryOptions, type SentryLikeEvent } from '../core/sentry.js';

const SIGNED_URL = 'https://public.dm.files.1drv.com/SIGNED-DOWNLOAD-MARKER-5531/video.mp4?tempauth=abc';

test('Sentry stays off when SENTRY_DSN is unset or blank', () => {
  assert.equal(sentryOptions({}).enabled, false);
  assert.equal(sentryOptions({ SENTRY_DSN: '  ' }).enabled, false);
  assert.equal(sentryOptions({ SENTRY_DSN: '  ' }).dsn, undefined);
});

test('errors only: no PII, tracing, trace headers or breadcrumbs', () => {
  const options = sentryOptions({ SENTRY_DSN: 'https://key@o0.ingest.sentry.io/1' });
  assert.equal(options.enabled, true);
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.tracesSampleRate, undefined);
  assert.deepEqual(options.tracePropagationTargets, []);
  assert.equal(options.maxBreadcrumbs, 0);
});

test('events keep only allowlisted fields: no request, user, host, extra, breadcrumbs or frame locals', () => {
  const event: SentryLikeEvent = scrubEvent<SentryLikeEvent>({
    event_id: 'e1',
    level: 'error',
    server_name: 'my-laptop',
    request: { url: SIGNED_URL },
    user: { ip_address: '1.2.3.4' },
    breadcrumbs: [{ message: 'fetch' }],
    extra: { transcript: 'private words' },
    contexts: { runtime: { name: 'node' }, os: { name: 'Linux' }, device: { hostname: 'my-laptop' }, app: { app_memory: 1 } },
    exception: {
      values: [{
        type: 'Error',
        value: `download failed for ${SIGNED_URL}`,
        stacktrace: { frames: [{ function: 'runTick', filename: 'node.mjs', lineno: 3, vars: { token: 'GATEWAY-TOKEN' }, context_line: 'secret' }] },
      }],
    },
  });
  assert.equal(event.event_id, 'e1');
  for (const key of ['server_name', 'request', 'user', 'breadcrumbs', 'extra']) assert.equal(event[key], undefined, key);
  assert.deepEqual(Object.keys(event.contexts ?? {}).sort(), ['os', 'runtime']);
  const value = event.exception!.values![0]!;
  assert.equal(value.value, '[redacted]');
  assert.deepEqual(value.stacktrace!.frames![0], { function: 'runTick', filename: 'node.mjs', lineno: 3 });
  assert.doesNotMatch(JSON.stringify(event), /SIGNED-DOWNLOAD-MARKER|GATEWAY-TOKEN|private words|my-laptop/);
});

test('only the app\'s own error messages pass; any other text is redacted', () => {
  for (const allowed of [
    'ai-gateway request failed with HTTP 502',
    'azure-speech request timed out',
    'GATEWAY_TOKEN is not set',
    'MEDIA_STATE=r2 is not available on this runtime',
    'MEDIA_SINK=notion is not available on this runtime',
    'azure-speech returned no transcription id',
    'deepgram did not finish within 30 minutes',
    'unknown summary profile meeting',
    'transcript is too long to summarize within the configured chunk size',
    'OneDrive is not linked; run the login command first',
    'OneDrive returned no download URL',
    'device login failed: authorization_declined',
    'device login expired',
    'AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT is not set',
    'no adapter for vendor whisper',
  ]) assert.equal(safeMessage(allowed), allowed);
  for (const leaked of [
    SIGNED_URL,
    'file Somchai salary review.mp4 not found',
    'deepgram failed: speaker said the merger closes Friday',
    'ENOENT: no such file or directory, open /home/me/Videos/private.mp4',
    'x'.repeat(121),
  ]) assert.equal(safeMessage(leaked), '[redacted]', leaked);
  assert.equal(safeMessage(undefined), '[redacted]');
});

test('tags and linked cause values are not sent', () => {
  const event: SentryLikeEvent = scrubEvent<SentryLikeEvent>({
    tags: { file: 'salary review.mp4' },
    exception: {
      values: [
        { type: 'Error', value: 'OneDrive returned no download URL', mechanism: { type: 'chained', source: 'cause', handled: true } },
        { type: 'Error', value: 'OneDrive returned no download URL' },
      ],
    },
  });
  assert.equal(event.tags, undefined);
  assert.equal(event.exception!.values![0]!.value, undefined);
  assert.equal(event.exception!.values![1]!.value, 'OneDrive returned no download URL');
});
