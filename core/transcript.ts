import type { Transcript, TranscriptSegment } from './types.js';

const THAI = /[฀-๿]/;
const CLOSING_PUNCT = /^[.,!?;:%)\]}’”…、。]/;

/**
 * Joins word tokens into readable text. Thai is written without spaces between
 * words, so two adjacent Thai tokens are joined directly; any other boundary
 * gets one space. Punctuation attaches to the previous token.
 */
export function joinTokens(tokens: string[]): string {
  let out = '';
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    if (!out) {
      out = token;
      continue;
    }
    const previous = out[out.length - 1];
    const glue = CLOSING_PUNCT.test(token) || (THAI.test(previous) && THAI.test(token[0])) ? '' : ' ';
    out += glue + token;
  }
  return out;
}

export interface WordToken {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
}

/** Groups word tokens into segments on speaker change, a pause, or a length cap. */
export function segmentWords(words: WordToken[], maxSeconds = 20, pauseSeconds = 1.5): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: { start: number; end: number; speaker: string | null; tokens: string[] } | null = null;
  for (const word of words) {
    const split = current && (
      word.speaker !== current.speaker
      || word.start - current.end > pauseSeconds
      || word.end - current.start > maxSeconds
    );
    if (!current || split) {
      if (current) segments.push({ start: current.start, end: current.end, speaker: current.speaker, text: joinTokens(current.tokens) });
      current = { start: word.start, end: word.end, speaker: word.speaker, tokens: [] };
    }
    current.tokens.push(word.text);
    current.end = Math.max(current.end, word.end);
  }
  if (current) segments.push({ start: current.start, end: current.end, speaker: current.speaker, text: joinTokens(current.tokens) });
  return segments.filter(segment => segment.text);
}

export function speakerLabel(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw).trim();
  if (/^\d+$/.test(value)) return `S${Number(value) + 1}`;
  return value.replace(/^speaker_?/i, 'S').slice(0, 16) || null;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

export function clock(seconds: number, millis = false): string {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const base = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return millis ? `${base},${pad(Math.round((safe % 1) * 1000) % 1000, 3)}` : base;
}

export function toSrt(transcript: Transcript): string {
  return transcript.segments
    .map((segment, index) => {
      const speaker = segment.speaker ? `[${segment.speaker}] ` : '';
      return `${index + 1}\n${clock(segment.start, true)} --> ${clock(segment.end, true)}\n${speaker}${segment.text}\n`;
    })
    .join('\n');
}

/** Compact "[hh:mm:ss] S1: text" lines; this is what the summarizer reads. */
export function toTimestampedText(transcript: Transcript): string {
  if (!transcript.segments.length) return transcript.text;
  return transcript.segments
    .map(segment => `[${clock(segment.start)}]${segment.speaker ? ` ${segment.speaker}:` : ''} ${segment.text}`)
    .join('\n');
}

export function fullText(segments: TranscriptSegment[]): string {
  return segments.map(segment => segment.text).join('\n');
}
