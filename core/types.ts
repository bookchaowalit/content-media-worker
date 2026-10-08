/**
 * Runtime-neutral contracts for the media worker.
 *
 * Everything under core/, stt/, sources/, summarize/ and state/ uses only Web
 * platform APIs (fetch, FormData, URL, TextEncoder) so the same code runs on
 * Node (any PaaS, Docker, Azure Container Apps, Railway) and on edge runtimes
 * such as Cloudflare Workers. Runtime-specific code lives in entry/.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Minimal key-value contract every state backend implements. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Optional atomic "set if absent with expiry"; true when the lock was taken. */
  tryLock?(key: string, ttlSeconds: number): Promise<boolean>;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
}

export interface Transcript {
  provider_id: string;
  language: string | null;
  duration_seconds: number | null;
  text: string;
  segments: TranscriptSegment[];
}

export interface SttRequest {
  mediaUrl: string;
  model: string;
  /** ISO 639-1 code, or null to let the provider detect the language. */
  language: 'th' | 'en' | null;
  diarization: boolean;
}

export type SttSubmitResult = { kind: 'job'; jobId: string } | { kind: 'transcript'; transcript: Transcript };
export type SttPollResult = { state: 'pending' } | { state: 'completed'; transcript: Transcript } | { state: 'failed'; reason: string };

export interface SttAdapter {
  readonly id: string;
  submit(request: SttRequest): Promise<SttSubmitResult>;
  poll(jobId: string): Promise<SttPollResult>;
}

export interface MediaItem {
  id: string;
  name: string;
  parent_id: string;
  folder_path: string;
  mime_type: string;
  size_bytes: number | null;
  duration_seconds: number | null;
}

export interface MediaSource {
  readonly id: string;
  /** New or changed media since the last call; the cursor is persisted by the source. */
  listChanges(): Promise<{ items: MediaItem[]; commit: () => Promise<void> }>;
  /** Short-lived URL the transcription provider fetches directly. Never logged or stored. */
  mediaUrl(item: MediaItem): Promise<string>;
}

export interface OutputFile {
  name: string;
  content: string;
  content_type: string;
}

export interface OutputSink {
  readonly id: string;
  write(item: MediaItem, files: OutputFile[]): Promise<void>;
}

export interface SummaryRequest {
  profile: string;
  gateway_route: string;
  prompt_version: string;
  gateway_profile: string;
  file_name: string;
  transcript: Transcript;
}

export interface Summarizer {
  summarize(request: SummaryRequest): Promise<string>;
}

export type WorkerLog = (event: string, fields?: Record<string, string | number | boolean | null>) => void;
