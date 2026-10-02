import type { Tokens } from './types';

export class ApiError extends Error {
  constructor(public status: number, public body: any, message?: string) { super(message ?? body?.message ?? `HTTP ${status}`); }
  /** Machine-readable code from the API (`error`), e.g. consent_required, validation_failed, rate_limited. */
  get code(): string | undefined { return typeof this.body?.error === 'string' ? this.body.error : undefined; }
}

const RT_KEY = 'edtech.rt';
type Listener = () => void;

/**
 * Thin fetch wrapper for the platform API.
 *  - the access token lives in memory only; the refresh token in sessionStorage (cleared when the tab closes). Trade-off: a stolen
 *    refresh token is single-use and reuse kills the whole session server-side, but any script on the page can read sessionStorage,
 *    so the app ships no third-party scripts and a strict CSP is expected in front of it (docs/guides/02-cloud-deployment.md).
 *  - a 401 triggers exactly one single-flight refresh and a retry; if refresh fails the user is signed out.
 *  - writes may carry an Idempotency-Key so a retry after a dropped connection can never double-apply.
 */
export class ApiClient {
  private access: string | null = null;
  private refreshing: Promise<boolean> | null = null;
  private onLogout = new Set<Listener>();
  constructor(private base = (import.meta as any).env?.VITE_API_URL ?? '', private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  get signedIn() { return !!this.access; }
  get hasRefreshToken() { return !!sessionStorage.getItem(RT_KEY); }
  subscribeLogout(fn: Listener) { this.onLogout.add(fn); return () => { this.onLogout.delete(fn); }; }

  setTokens(t: Pick<Tokens, 'accessToken' | 'refreshToken'>) { this.access = t.accessToken; sessionStorage.setItem(RT_KEY, t.refreshToken); }
  clear() { this.access = null; sessionStorage.removeItem(RT_KEY); this.onLogout.forEach((f) => f()); }

  /** Restores a session after a page reload from the stored refresh token. */
  async restore(): Promise<boolean> { return this.access ? true : this.refresh(); }

  private async refresh(): Promise<boolean> {
    const rt = sessionStorage.getItem(RT_KEY); if (!rt) return false;
    this.refreshing ??= (async () => {
      try {
        const r = await this.fetchImpl(`${this.base}/v1/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
        if (!r.ok) return false;
        const t = (await r.json()) as Tokens; this.setTokens(t); return true;
      } catch { return false; } finally { setTimeout(() => { this.refreshing = null; }, 0); }
    })();
    const ok = await this.refreshing; if (!ok) { this.access = null; sessionStorage.removeItem(RT_KEY); }
    return ok;
  }

  async request<T = any>(method: string, path: string, opts: { body?: unknown; raw?: BodyInit; headers?: Record<string, string>; idempotencyKey?: string; auth?: boolean; _retried?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    if (opts.auth !== false && this.access) headers.Authorization = `Bearer ${this.access}`;
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
    if (res.status === 401 && opts.auth !== false && !opts._retried) {
      if (await this.refresh()) return this.request<T>(method, path, { ...opts, _retried: true });
      this.clear(); throw new ApiError(401, { error: 'unauthorized', message: 'Your session has ended. Please sign in again.' });
    }
    const text = await res.text(); let body: any = text; try { body = text ? JSON.parse(text) : null; } catch { /* plain text */ }
    if (!res.ok) throw new ApiError(res.status, body);
    return body as T;
  }

  get<T = any>(path: string) { return this.request<T>('GET', path); }
  post<T = any>(path: string, body?: unknown, idempotencyKey?: string) { return this.request<T>('POST', path, { body: body ?? {}, idempotencyKey }); }
  put<T = any>(path: string, body?: unknown) { return this.request<T>('PUT', path, { body }); }
  upload<T = any>(path: string, file: Blob) { return this.request<T>('PUT', path, { raw: file, headers: { 'Content-Type': 'application/octet-stream' } }); }

  // ---- auth ----
  async login(email: string, password: string): Promise<{ status: 'ok' } | { status: 'staff'; reason: 'mfa' | 'enroll' }> {
    const r = await this.request<any>('POST', '/v1/auth/login', { body: { email, password }, auth: false });
    if (r.accessToken) { this.setTokens(r); return { status: 'ok' }; }
    return { status: 'staff', reason: r.mfaRequired ? 'mfa' : 'enroll' };
  }
  async logout() { try { await this.request('POST', '/v1/auth/logout', { body: {} }); } catch { /* already gone */ } this.clear(); }
}

export const api = new ApiClient();

/** A friendly message for an error shown to a learner. Never exposes raw server text for 5xx. */
export function messageFor(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0 || e.status >= 500) return 'Something went wrong on our side. Please try again in a moment.';
    if (e.status === 429) return 'Too many requests. Please wait a few seconds and try again.';
    if (e.code === 'consent_required') return 'You need to accept the notice for this feature first.';
    if (e.status === 403) return typeof e.body?.message === 'string' ? e.body.message : 'This is not available to you yet.';
    if (typeof e.body?.message === 'string') return e.body.message;
    if (Array.isArray(e.body?.message)) return e.body.message.join(', ');
  }
  return 'Could not reach the server. Check your connection and try again.';
}
