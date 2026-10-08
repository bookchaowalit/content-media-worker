import { requestJson } from '../core/http.js';
import { toTimestampedText } from '../core/transcript.js';
import type { FetchLike, Summarizer, SummaryRequest } from '../core/types.js';
import { CHUNK_NOTES_PROMPT, PROFILE_PROMPTS } from './prompts.js';

export interface GatewaySummarizerOptions {
  baseUrl: string;
  token: string;
  fetch: FetchLike;
  /** Characters per transcript chunk; keep below the gateway's AI_GATEWAY_MAX_CONTEXT_CHARS. */
  chunkChars?: number;
  tokenBudget?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export function splitLines(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const piece = line.length > maxChars ? line.slice(0, maxChars) : line;
    if (current && current.length + piece.length + 1 > maxChars) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Summarizes through the Central AI Gateway, so the model, provider, budget and
 * Thai-first policy are owned by the gateway, not by this worker. Long
 * transcripts are reduced chunk by chunk into notes before the final pass.
 */
export function createGatewaySummarizer(options: GatewaySummarizerOptions): Summarizer {
  const base = options.baseUrl.replace(/\/$/, '');
  const chunkChars = options.chunkChars ?? 24_000;
  const tokenBudget = options.tokenBudget ?? 16_384;
  const maxOutputTokens = options.maxOutputTokens ?? 4_096;

  async function generate(request: SummaryRequest, promptVersion: string, system: string, user: string): Promise<string> {
    const body = await requestJson<{ content: string }>(
      options.fetch,
      `${base}/api/ai/generate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          route: request.gateway_route,
          prompt_version: promptVersion,
          profile: request.gateway_profile,
          privacy_class: 'internal',
          token_budget: tokenBudget,
          max_output_tokens: maxOutputTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      },
      { label: 'ai-gateway', timeoutMs: options.timeoutMs ?? 180_000 },
    );
    return body.content;
  }

  return {
    async summarize(request: SummaryRequest): Promise<string> {
      const system = PROFILE_PROMPTS[request.profile];
      if (!system) throw new Error(`unknown summary profile ${request.profile}`);
      const header = `ไฟล์: ${request.file_name}\n`;
      let text = toTimestampedText(request.transcript);
      let label = '';
      // Reduce in rounds until the material fits one call; each round shrinks
      // the text to notes, so three rounds cover very long recordings.
      for (let round = 0; text.length > chunkChars && round < 3; round += 1) {
        const chunks = splitLines(text, chunkChars);
        const notes: string[] = [];
        for (const [index, chunk] of chunks.entries()) {
          notes.push(await generate(request, `${request.prompt_version}-chunk`, CHUNK_NOTES_PROMPT, `${header}ส่วนที่ ${index + 1}/${chunks.length}\n${chunk}`));
        }
        text = notes.join('\n\n');
        label = `(โน้ตที่ย่อจาก transcript ${chunks.length} ส่วน)\n`;
      }
      if (text.length > chunkChars) throw new Error('transcript is too long to summarize within the configured chunk size');
      return generate(request, request.prompt_version, system, header + label + text);
    },
  };
}
