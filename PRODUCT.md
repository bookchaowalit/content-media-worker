# content-media-worker — Product Brief

Status on 2026-10-22: **built, not deployed, not verified against a real recording.** The registry
(`online-systems.yaml`, id `media-worker`) lists it as local only. There is no `wrangler.toml` (only
`wrangler.toml.example`), no deploy workflow and no live URL. The product card's next step, "transcribe one
real sample file", is still open.

## Who it is for

The owner, who wants long meeting and video recordings dropped in a OneDrive folder turned into a
timestamped transcript and a Thai summary without keeping a laptop running. There are no other users.

## What exists

| Capability | Detail |
|---|---|
| OneDrive source | polls a folder (`ONEDRIVE_ROOT_PATH`, default `/Transcribe`) through Microsoft Graph delta; device-code login stores a rotating refresh token in the state store |
| Speech-to-text | adapters for Speechmatics, Azure Speech batch, ElevenLabs Scribe v2, Gladia, AssemblyAI and Deepgram Nova-3 (`stt/`); the provider is chosen per language from `vendor/media-transcription-routing.json` and only among providers whose key is set |
| Summary | calls the owner's AI gateway (`AI_GATEWAY_URL` + `AI_GATEWAY_TOKEN`, `POST /api/ai/generate`); long transcripts are reduced chunk by chunk first |
| Outputs | transcript text, SRT and a Markdown summary written next to the video (`MEDIA_SINK=onedrive`) or to a local folder (`file`) |
| Job state | Upstash Redis, Cloudflare KV or a local JSON file; retries with a cap (`MEDIA_MAX_ATTEMPTS`), a per-tick job cap (`MEDIA_MAX_JOBS_PER_TICK`) and a tick lock |
| Operator tools | `transcribe --url … --name …` (one URL, no OneDrive) and `eval --manifest …` (score providers against reference transcripts; CER for Thai, WER for English) |
| Runtimes | Node (`dist/node.mjs`, `once` / `loop` / `login`; `Dockerfile` runs `loop`) and Cloudflare Workers (`dist/cloudflare.mjs`, cron trigger; HTTP answers a health check only) |
| Error reporting | Sentry in the Node entry when `SENTRY_DSN` is set (errors only, events rebuilt from an allowlist; see `core/sentry.ts`). The Cloudflare entry has no Sentry |
| Checks | `npm run typecheck` (strict), `npm test` (4 files in `test/`), `npm run build`; shared CI on every push |

## How to run

See README.md: `npm ci`, `npm test`, `npm run build`, then `node dist/node.mjs once|loop|login|transcribe|eval`
with keys in `.env.local` (gitignored). The Node entry exits 1 and names the missing variables when
`ONEDRIVE_CLIENT_ID`, `AI_GATEWAY_URL` or `AI_GATEWAY_TOKEN` are unset.

## AI

- **LLM:** none called directly. Summaries go through the owner's AI gateway with route ids
  `media-summary-meeting` (profile `quality`), `media-summary-edit` and `media-summary-content` (profile `balanced`),
  `privacy_class: internal`, a token budget (default 16 384) and a max output (default 4 096) per call. The provider
  and model ids are owned by the gateway, not by this repo, so they are not recorded here.
- **Speech-to-text models:** Speechmatics `enhanced`, Azure `batch-transcription`, ElevenLabs `scribe_v2`, Gladia
  `default`, AssemblyAI `universal`, Deepgram `nova-3`.
- **Fallback:** the router ranks STT candidates (own eval score when present, else registry order). A retryable
  error is retried up to `MEDIA_MAX_ATTEMPTS`; after that, an STT-stage failure moves the job to the next ranked
  provider, and when none is left the job is marked failed. There is no second summarizer: a gateway failure is
  retried, then the job fails.
- **Prompt safety:** the prompts tell the model that the transcript is data, not instructions.
- **Open-relay audit (2026-10-22):** no inbound path reaches the gateway or an STT provider. The Cloudflare `fetch`
  handler returns `{"status":"ok"}` and makes no outbound call; the Node entry has no HTTP server; work starts only
  from the cron trigger / loop on the owner's own folder. Pinned by `test/entry.test.ts`. Keys come from env or
  `wrangler secret`, are never logged (provider errors carry label and status only), and a scan of the git history
  found no key-shaped strings.
- **Eval status:** an eval harness exists (`eval` command, CER/WER), but `own_eval` is empty for every provider in
  the registry. gap: no reference set is committed (`samples.json` is gitignored) and no threshold is set.
- gap: no demo mode; without keys the worker refuses to start rather than returning sample output.
- gap: no spend cap inside this repo beyond the per-call token budget and per-tick job cap; daily budget is
  expected from the gateway and STT provider accounts, which this repo cannot verify.

## Limits

- `vendor/` is a copy of the router and registry from solo-empire and can drift from the original.
- Not run end to end against real providers in this repo's history that we can verify.
- Disposition: personal lab tool (product card verdict `showcase`).
