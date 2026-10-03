import { api as defaultApi } from '../../api/client';
import type { Interaction, Playback } from '../../api/types';
import { tr } from '../i18n';
import { decryptLesson, deviceKeys } from './crypto';
import { idbAll, idbClear, idbDelete, idbGet, idbPut } from './idb';

export type OfflineCode = 'expired' | 'revoked' | 'clock' | 'missing' | 'storage' | 'unsupported' | 'network' | 'failed';
export class OfflineError extends Error {
  constructor(public code: OfflineCode, message: string) { super(message); }
}
export const offlineMessage = (e: unknown): string => e instanceof OfflineError ? e.message : tr('The download did not work. Check your connection and try again.');

/** What is kept for one downloaded lesson. The key is wrapped for this device; the ciphertext lives in its own store. */
export interface OfflineLesson {
  assetId: string; licenseId: string; topicId: string; entitlementId: string; userId: string; title: string; language: string; label: string; durationSec: number; interactions: Interaction[];
  wrappedKey: string; iv: string; tag: string; expiresAt: string; downloadedAt: string; size: number; captions?: string; transcript?: string;
}
interface LicenseResponse { licenseId: string; assetId: string; label: string; expiresAt: string; wrappedKey: string; iv: string; tag: string; downloadUrl: string; interactions: Interaction[]; durationSec: number }
interface LicenseStatus { licenseId: string; assetId: string; expiresAt: string; status: string; valid: boolean }
type ApiLike = Pick<typeof defaultApi, 'get' | 'post'> & { baseUrl?: string };

const SKEW_MS = 5 * 60_000;
const online = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

/**
 * Lessons a learner saves to this device to watch without a connection. The server issues a device-bound licence (expires with the
 * entitlement, at most OFFLINE_DAYS), the encrypted file is stored here, and it is decrypted only in memory when played. Licences are
 * checked with the server whenever the device is online, and against the clock (including a rolled-back clock) when it is not.
 */
export class OfflineLessons {
  constructor(private api: ApiLike = defaultApi, private fetchImpl: typeof fetch = (...a) => fetch(...a), private now: () => number = Date.now) {}

  supported() { return typeof indexedDB !== 'undefined' && !!globalThis.crypto?.subtle; }

  async list(userId?: string): Promise<OfflineLesson[]> {
    if (!this.supported()) return [];
    const all = (await idbAll<OfflineLesson>('lessons')).map((x) => x.value);
    return all.filter((l) => !userId || l.userId === userId).sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
  }
  async has(assetId: string) { return !!(await idbGet('lessons', assetId)); }

  async download(a: { topicId: string; entitlementId: string; title: string; language: string; userId: string }, onProgress?: (fraction: number) => void): Promise<OfflineLesson> {
    if (!this.supported()) throw new OfflineError('unsupported', tr('This browser cannot keep lessons offline.'));
    if (!online()) throw new OfflineError('network', tr('You need a connection to download a lesson.'));
    const keys = await deviceKeys();
    try {
      await this.api.post('/v1/offline/devices', { deviceId: keys.deviceId, publicKeyPem: keys.publicKeyPem });
      const lic = await this.api.post<LicenseResponse>('/v1/offline/licenses', { deviceId: keys.deviceId, topicId: a.topicId, language: a.language });
      const res = await this.fetchImpl(this.abs(lic.downloadUrl)); if (!res.ok) throw new OfflineError('failed', tr('The download did not work. Check your connection and try again.'));
      const total = Number(res.headers.get('Content-Length')) || 0; await this.checkSpace(total);
      const data = await this.readAll(res, total, onProgress);
      // captions and transcript are small text files from the normal playback manifest; the lesson works without them
      let captions: string | undefined, transcript: string | undefined;
      try {
        const pb = await this.api.get<Playback>(`/v1/topics/${a.topicId}/playback?language=${encodeURIComponent(a.language)}`);
        const text = async (label: string) => { const s = pb.streams.find((x) => x.label === label); return s ? (await (await this.fetchImpl(this.abs(s.url))).text()) : undefined; };
        [captions, transcript] = await Promise.all([text('captions').catch(() => undefined), text('transcript').catch(() => undefined)]);
      } catch { /* optional */ }
      const lesson: OfflineLesson = { assetId: lic.assetId, licenseId: lic.licenseId, topicId: a.topicId, entitlementId: a.entitlementId, userId: a.userId, title: a.title, language: a.language, label: lic.label, durationSec: lic.durationSec, interactions: lic.interactions ?? [],
        wrappedKey: lic.wrappedKey, iv: lic.iv, tag: lic.tag, expiresAt: lic.expiresAt, downloadedAt: new Date(this.now()).toISOString(), size: data.byteLength, captions, transcript };
      await idbPut('blobs', lic.assetId, data); await idbPut('lessons', lic.assetId, lesson); await this.touch();
      void navigator.storage?.persist?.().catch(() => undefined);
      return lesson;
    } catch (e) {
      if (e instanceof OfflineError) throw e;
      const status = (e as { status?: number })?.status;
      throw new OfflineError(status === 409 || status === 403 ? 'failed' : 'failed', status === 409 ? tr('You can keep lessons on at most 3 devices. Remove one from another device first.') : status === 403 ? tr('Downloads are not available for this lesson right now.') : tr('The download did not work. Check your connection and try again.'));
    }
  }

  async remove(assetId: string) { await idbDelete('lessons', assetId); await idbDelete('blobs', assetId); }
  async removeAll() { await idbClear('lessons'); await idbClear('blobs'); }

  /** While online, asks the server which licences are still good and deletes the rest (revoked, expired, entitlement ended). Only this person's lessons are judged: the server answers for the signed-in user alone. */
  async sync(userId?: string): Promise<string[]> {
    if (!this.supported() || !online()) return [];
    const have = await this.list(userId); if (!have.length) return [];
    let remote: LicenseStatus[]; try { remote = await this.api.get<LicenseStatus[]>(`/v1/offline/licenses?deviceId=${encodeURIComponent((await deviceKeys()).deviceId)}`); } catch { return []; }
    const ok = new Map(remote.map((r) => [r.licenseId, r])); const removed: string[] = [];
    for (const l of have) { const r = ok.get(l.licenseId); if (!r || !r.valid) { await this.remove(l.assetId); removed.push(l.assetId); } }
    await this.touch(); return removed;
  }

  /** Decrypts a lesson in memory and returns a Playback the normal player understands. Call `release()` when done. */
  async open(assetId: string): Promise<{ playback: Playback; lesson: OfflineLesson; release: () => void }> {
    const lesson = await idbGet<OfflineLesson>('lessons', assetId); const data = await idbGet<ArrayBuffer>('blobs', assetId);
    if (!lesson || !data) throw new OfflineError('missing', tr('This lesson is no longer on this device.'));
    if (online()) { const gone = await this.sync(lesson.userId); if (gone.includes(assetId)) throw new OfflineError('revoked', tr('Your access to this lesson has ended, so it was removed from this device.')); }
    const now = this.now(); const seen = (await idbGet<number>('kv', 'lastSeen')) ?? 0;
    if (now + SKEW_MS < seen) throw new OfflineError('clock', tr("This device's clock looks wrong. Connect to the internet to continue."));
    if (Date.parse(lesson.expiresAt) <= now) { await this.remove(assetId); throw new OfflineError('expired', tr('This download has expired. Connect to the internet and download it again.')); }
    const keys = await deviceKeys(); let plain: ArrayBuffer;
    try { plain = await decryptLesson({ data, wrappedKey: lesson.wrappedKey, iv: lesson.iv, tag: lesson.tag }, keys.privateKey); }
    catch { throw new OfflineError('failed', tr('This lesson could not be unlocked on this device. Delete it and download it again.')); }
    await this.touch();
    const urls: string[] = []; const url = (parts: BlobPart[], type: string) => { const u = URL.createObjectURL(new Blob(parts, { type })); urls.push(u); return u; };
    const streams = [{ label: 'offline', mime: 'video/mp4', url: url([plain], 'video/mp4') }, ...(lesson.captions ? [{ label: 'captions', mime: 'text/vtt', url: url([lesson.captions], 'text/vtt') }] : []), ...(lesson.transcript ? [{ label: 'transcript', mime: 'text/plain', url: url([lesson.transcript], 'text/plain') }] : [])];
    return { lesson, playback: { assetId: lesson.assetId, language: lesson.language, durationSec: lesson.durationSec, mode: 'normal', streams, interactions: lesson.interactions, resume: { sec: 0 } }, release: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
  }

  /** Total bytes kept, and what the browser says is free. */
  async usage() { const used = (await this.list()).reduce((n, l) => n + l.size, 0); const est = await navigator.storage?.estimate?.().catch(() => undefined); return { used, quota: est?.quota, free: est?.quota !== undefined && est.usage !== undefined ? est.quota - est.usage : undefined }; }

  private abs(path: string) { return /^https?:/.test(path) ? path : `${this.api.baseUrl ?? ''}${path}`; }
  private async touch() { const prev = (await idbGet<number>('kv', 'lastSeen')) ?? 0; await idbPut('kv', 'lastSeen', Math.max(prev, this.now())); }
  private async checkSpace(bytes: number) {
    const est = await navigator.storage?.estimate?.().catch(() => undefined); if (!bytes || !est?.quota || est.usage === undefined) return;
    if (est.quota - est.usage < bytes * 1.3) throw new OfflineError('storage', tr('There is not enough space on this device for this lesson. Remove a download and try again.'));
  }
  private async readAll(res: Response, total: number, onProgress?: (f: number) => void): Promise<ArrayBuffer> {
    if (!res.body?.getReader) { const b = await res.arrayBuffer(); onProgress?.(1); return b; }
    const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; if (total) onProgress?.(Math.min(1, got / total)); }
    const out = new Uint8Array(got); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } onProgress?.(1); return out.buffer;
  }
}
export const offlineLessons = new OfflineLessons();
