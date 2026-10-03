import { createSign } from 'crypto';
import type { Agent } from 'https';
import webpush from 'web-push';
import { external } from '../platform/trace';

export interface PushMessage { title: string; body: string; url?: string; tag?: string }
export interface PushTarget { id: string; platform: string; token: string; keys?: { p256dh: string; auth: string } | null }
/** sent: delivered to the push service. gone: the device is permanently unreachable (unsubscribed, app removed): stop sending. retry: try again later. */
export type PushResult = 'sent' | 'gone' | 'retry';
export interface PushProvider { readonly name: string; supports(platform: string): boolean; send(t: PushTarget, m: PushMessage): Promise<PushResult> }
export const PUSH_PROVIDERS = Symbol('PUSH_PROVIDERS');

/** Development: writes what would have been sent. Never used when PUSH_MODE=live. */
export class LogPushProvider implements PushProvider {
  readonly name = 'log'; sent: { to: string; message: PushMessage }[] = [];
  supports() { return true; }
  async send(t: PushTarget, m: PushMessage): Promise<PushResult> { this.sent.push({ to: `${t.platform}:${t.id}`, message: m }); if (process.env.NODE_ENV !== 'test') process.stdout.write(`${JSON.stringify({ level: 'info', ctx: 'push', msg: 'would push', to: `${t.platform}:${t.id}`, title: m.title })}\n`); return 'sent'; }
}

/**
 * Standard Web Push (RFC 8030, encrypted with RFC 8291, authorised with VAPID RFC 8292): works for Chrome, Edge, Firefox, Safari 16.4+ and
 * installed web apps, with no vendor SDK. Keys: `npx web-push generate-vapid-keys`.
 */
export class WebPushProvider implements PushProvider {
  readonly name = 'webpush';
  /** `agent` lets a deployment route pushes through its egress proxy (and lets tests use a stand-in push service). */
  constructor(private vapid: { publicKey: string; privateKey: string; subject: string }, private ttlSec = 24 * 3600, private agent?: Agent) {}
  supports(p: string) { return p === 'WEB'; }
  async send(t: PushTarget, m: PushMessage): Promise<PushResult> {
    if (!t.keys) return 'gone';
    try {
      await external('push', 'webpush', () => webpush.sendNotification({ endpoint: t.token, keys: t.keys! }, JSON.stringify(m), { TTL: this.ttlSec, urgency: 'normal', vapidDetails: this.vapid, timeout: 10_000, ...(this.agent && { agent: this.agent }) }));
      return 'sent';
    } catch (e: any) { return e?.statusCode === 404 || e?.statusCode === 410 || e?.statusCode === 400 ? 'gone' : 'retry'; } // 404/410: unsubscribed; 400 is a malformed subscription that will never work
  }
}

/** Firebase Cloud Messaging HTTP v1: carries Android, and iOS through APNs (upload the APNs key in the Firebase console). The service-account JSON signs a short-lived OAuth token. */
export interface ServiceAccount { project_id: string; client_email: string; private_key: string; token_uri?: string }
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
export function signServiceJwt(sa: ServiceAccount, now = Date.now()): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })); const iat = Math.floor(now / 1000);
  const claims = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key); return `${head}.${claims}.${b64u(sig)}`;
}
export class FcmProvider implements PushProvider {
  readonly name = 'fcm'; private token?: { v: string; exp: number };
  constructor(private sa: ServiceAccount, private f: typeof fetch = (...a) => fetch(...a), private now: () => number = Date.now) {}
  supports(p: string) { return p === 'ANDROID' || p === 'IOS'; }
  private async access(): Promise<string> {
    if (this.token && this.token.exp - 60_000 > this.now()) return this.token.v;
    const r = await this.f(this.sa.token_uri ?? 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signServiceJwt(this.sa, this.now()) }) });
    if (!r.ok) throw new Error(`fcm auth ${r.status}`); const j: any = await r.json(); this.token = { v: j.access_token, exp: this.now() + (j.expires_in ?? 3600) * 1000 }; return this.token.v;
  }
  async send(t: PushTarget, m: PushMessage): Promise<PushResult> {
    try {
      const res = await external('push', 'fcm', async () => this.f(`https://fcm.googleapis.com/v1/projects/${this.sa.project_id}/messages:send`, { method: 'POST', headers: { Authorization: `Bearer ${await this.access()}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ message: { token: t.token, notification: { title: m.title, body: m.body }, data: { ...(m.url && { url: m.url }), ...(m.tag && { tag: m.tag }) }, android: { priority: 'HIGH' }, apns: { headers: { 'apns-priority': '5' }, payload: { aps: { sound: 'default' } } } } }) }));
      if (res.ok) return 'sent';
      const body: any = await res.json().catch(() => ({})); const code = body?.error?.details?.find((d: any) => d.errorCode)?.errorCode ?? body?.error?.status;
      if (res.status === 404 || code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT') return 'gone'; if (res.status === 401) this.token = undefined; return 'retry';
    } catch { return 'retry'; }
  }
}

export function buildPushProviders(env: NodeJS.ProcessEnv = process.env): PushProvider[] {
  if (env.PUSH_MODE === 'log') return [new LogPushProvider()];
  if (env.PUSH_MODE !== 'live') return [];
  const out: PushProvider[] = [];
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) out.push(new WebPushProvider({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT ?? 'mailto:support@example.edu' }));
  if (env.FCM_SERVICE_ACCOUNT) { try { out.push(new FcmProvider(JSON.parse(env.FCM_SERVICE_ACCOUNT))); } catch { /* reported by the config guard */ } }
  return out;
}
