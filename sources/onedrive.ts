import { request, requestJson } from '../core/http.js';
import type { FetchLike, KeyValueStore, MediaItem, MediaSource, OutputFile, OutputSink } from '../core/types.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'Files.ReadWrite offline_access';
export const ONEDRIVE_REFRESH_KEY = 'onedrive:refresh_token';
const DELTA_KEY = 'onedrive:delta_link';
const MEDIA_MIME = /^(video|audio)\//i;

export interface OneDriveOptions {
  clientId: string;
  kv: KeyValueStore;
  fetch: FetchLike;
  /** Folder the worker watches, relative to the drive root, e.g. "/Transcribe". */
  rootPath: string;
  /** "consumers" for personal Microsoft accounts. */
  tenant?: string;
  /** Used once when the store has no refresh token yet. */
  bootstrapRefreshToken?: string;
  /** Process files that already exist on the first run instead of starting from now. */
  backfill?: boolean;
}

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  deleted?: unknown;
  file?: { mimeType?: string };
  parentReference?: { id?: string; path?: string };
  video?: { duration?: number };
  audio?: { duration?: number };
}

export function tokenEndpoint(tenant = 'consumers'): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
}

function encodePath(path: string): string {
  const clean = `/${path.replace(/^\/+|\/+$/g, '')}`;
  return clean.split('/').map(encodeURIComponent).join('/');
}

export function toMediaItem(item: DriveItem): MediaItem | null {
  if (item.deleted || !item.file || !MEDIA_MIME.test(item.file.mimeType || '')) return null;
  const parentPath = (item.parentReference?.path || '').replace(/^\/drive\/root:?/, '') || '/';
  const durationMs = item.video?.duration ?? item.audio?.duration;
  return {
    id: item.id,
    name: item.name,
    parent_id: item.parentReference?.id || '',
    folder_path: decodeURIComponent(parentPath),
    mime_type: item.file.mimeType || '',
    size_bytes: typeof item.size === 'number' ? item.size : null,
    duration_seconds: typeof durationMs === 'number' ? Math.round(durationMs / 1000) : null,
  };
}

/**
 * Personal OneDrive through Microsoft Graph with a public-client refresh token.
 * Microsoft rotates refresh tokens, so every new one is written back to the
 * state store; tokens are never logged or returned.
 */
export class OneDrive implements MediaSource {
  readonly id = 'onedrive';
  private accessToken: string | null = null;
  private readonly tenant: string;

  constructor(private readonly options: OneDriveOptions) {
    this.tenant = options.tenant || 'consumers';
  }

  private async token(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const refreshToken = (await this.options.kv.get(ONEDRIVE_REFRESH_KEY)) || this.options.bootstrapRefreshToken;
    if (!refreshToken) throw new Error('OneDrive is not linked; run the login command first');
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: SCOPE,
    });
    const token = await requestJson<{ access_token: string; refresh_token?: string }>(
      this.options.fetch,
      `${tokenEndpoint(this.tenant)}/token`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
      { label: 'microsoft-identity' },
    );
    if (token.refresh_token) await this.options.kv.put(ONEDRIVE_REFRESH_KEY, token.refresh_token);
    this.accessToken = token.access_token;
    return token.access_token;
  }

  private async graph<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${await this.token()}` };
    return requestJson<T>(this.options.fetch, url.startsWith('http') ? url : `${GRAPH}${url}`, { ...init, headers }, { label: 'microsoft-graph' });
  }

  async listChanges(): Promise<{ items: MediaItem[]; commit: () => Promise<void> }> {
    const saved = await this.options.kv.get(DELTA_KEY);
    const folder = `/me/drive/root:${encodePath(this.options.rootPath)}:/delta`;
    if (!saved && !this.options.backfill) {
      // First run: start from "now" so existing videos are not transcribed.
      const latest = await this.graph<{ '@odata.deltaLink'?: string }>(`${folder}?token=latest`);
      const link = latest['@odata.deltaLink'];
      return { items: [], commit: async () => { if (link) await this.options.kv.put(DELTA_KEY, link); } };
    }
    const items: MediaItem[] = [];
    let next: string | undefined = saved || folder;
    let deltaLink: string | undefined;
    // Delta responses omit parentReference.path, but routing depends on the
    // folder (Meetings / Edit / Content), so resolve each parent once per run.
    const folderPaths = new Map<string, string>();
    for (let page = 0; next && page < 50; page += 1) {
      const body: { value?: DriveItem[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string } = await this.graph(next);
      for (const item of body.value || []) {
        const media = toMediaItem(item);
        if (!media) continue;
        if (!item.parentReference?.path && media.parent_id) {
          if (!folderPaths.has(media.parent_id)) folderPaths.set(media.parent_id, await this.folderPath(media.parent_id));
          media.folder_path = folderPaths.get(media.parent_id)!;
        }
        items.push(media);
      }
      next = body['@odata.nextLink'];
      deltaLink = body['@odata.deltaLink'] ?? deltaLink;
    }
    return { items, commit: async () => { if (deltaLink) await this.options.kv.put(DELTA_KEY, deltaLink); } };
  }

  /** Drive-relative path of a folder, e.g. "/Transcribe/Meetings". */
  async folderPath(folderId: string): Promise<string> {
    const folder = await this.graph<DriveItem>(`/me/drive/items/${encodeURIComponent(folderId)}?$select=id,name,parentReference`);
    const parent = (folder.parentReference?.path || '').replace(/^\/drive\/root:?/, '');
    // The drive root itself has no parent path.
    if (!folder.parentReference?.path) return '/';
    return decodeURIComponent(`${parent}/${folder.name}`.replace(/^\/{2,}/, '/'));
  }

  async mediaUrl(item: MediaItem): Promise<string> {
    const body = await this.graph<Record<string, string>>(`/me/drive/items/${encodeURIComponent(item.id)}?$select=id,@microsoft.graph.downloadUrl`);
    const url = body['@microsoft.graph.downloadUrl'];
    if (!url) throw new Error('OneDrive returned no download URL');
    return url;
  }

  /** Simple upload (< 4 MB) next to the source file. */
  async writeFile(parentId: string, file: OutputFile): Promise<void> {
    const url = `${GRAPH}/me/drive/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(file.name)}:/content`;
    await request(
      this.options.fetch,
      url,
      { method: 'PUT', headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': file.content_type }, body: file.content },
      { label: 'microsoft-graph' },
    );
  }
}

/** Writes results back into the same OneDrive folder as the video. */
export class OneDriveSink implements OutputSink {
  readonly id = 'onedrive';
  constructor(private readonly drive: OneDrive) {}
  async write(item: MediaItem, files: OutputFile[]): Promise<void> {
    for (const file of files) await this.drive.writeFile(item.parent_id, file);
  }
}

/** Device-code login for a public client. Returns the refresh token to the caller only. */
export async function deviceCodeLogin(options: {
  clientId: string;
  fetch: FetchLike;
  tenant?: string;
  prompt: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const base = tokenEndpoint(options.tenant);
  const sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const code = await requestJson<{ device_code: string; user_code: string; verification_uri: string; interval?: number; expires_in: number }>(
    options.fetch,
    `${base}/devicecode`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: options.clientId, scope: SCOPE }) },
    { label: 'microsoft-identity' },
  );
  options.prompt(`Open ${code.verification_uri} and enter code ${code.user_code}`);
  const deadline = Date.now() + code.expires_in * 1000;
  let interval = (code.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const response = await options.fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: options.clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.device_code }),
    });
    const body = (await response.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
    if (response.ok && body.refresh_token) return body.refresh_token;
    if (body.error === 'slow_down') interval += 5_000;
    else if (body.error !== 'authorization_pending') throw new Error(`device login failed: ${String(body.error || response.status).slice(0, 40)}`);
  }
  throw new Error('device login expired');
}
