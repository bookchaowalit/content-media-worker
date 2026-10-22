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
  assert.equal(value.value, 'unexpected error');
  assert.deepEqual(value.stacktrace!.frames![0], { function: 'runTick', filename: 'node.mjs', lineno: 3 });
  assert.doesNotMatch(JSON.stringify(event), /SIGNED-DOWNLOAD-MARKER|GATEWAY-TOKEN|private words|my-laptop/);
});

test('short plain messages pass; anything with query strings or quotes is replaced', () => {
  assert.equal(safeMessage('ai-gateway request failed with HTTP 502'), 'ai-gateway request failed with HTTP 502');
  assert.equal(safeMessage(SIGNED_URL), 'unexpected error');
  assert.equal(safeMessage(undefined), 'unexpected error');
  assert.equal(safeMessage('x'.repeat(121)), 'unexpected error');
});
