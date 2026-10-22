import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import worker from '../entry/cloudflare.js';

// The worker has no inbound path to the AI gateway or the speech-to-text providers:
// HTTP only answers a health check, and work starts only from the cron trigger.
test('Cloudflare fetch is health only and never calls out, whatever the request asks for', async () => {
  const realFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound += 1; return new Response('{}'); }) as typeof fetch;
  try {
    const response = await worker.fetch();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.equal(outbound, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Cloudflare cron tick fails closed without configuration and names only the missing variables', async () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const lines: string[] = [];
  let outbound = 0;
  let scheduled = 0;
  globalThis.fetch = (async () => { outbound += 1; return new Response('{}'); }) as typeof fetch;
  console.log = (line: string) => { lines.push(line); };
  try {
    await worker.scheduled({}, { AI_GATEWAY_TOKEN: 'GATEWAY-TOKEN-MARKER-1' }, { waitUntil: () => { scheduled += 1; } });
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  assert.equal(outbound, 0);
  assert.equal(scheduled, 0);
  const event = JSON.parse(lines[0]!);
  assert.equal(event.event, 'media.config_invalid');
  assert.match(event.problems, /ONEDRIVE_CLIENT_ID is not set/);
  assert.match(event.problems, /AI_GATEWAY_URL is not set/);
  assert.doesNotMatch(lines.join('\n'), /GATEWAY-TOKEN-MARKER/);
});

test('Node entry reports which variables are missing instead of "unexpected error", and exits non-zero', () => {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', MEDIA_STATE: 'file', MEDIA_STATE_PATH: '/nonexistent/state.json' };
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'entry/node.ts', 'once'], { env, encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(run.status, 0);
  const output = run.stdout + run.stderr;
  assert.match(output, /ONEDRIVE_CLIENT_ID is not set/);
  assert.match(output, /AI_GATEWAY_TOKEN is not set/);
  assert.doesNotMatch(output, /unexpected error/);
});
