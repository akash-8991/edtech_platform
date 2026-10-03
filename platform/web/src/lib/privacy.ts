import type { Prefs, PrivacyRequest } from '../api/types';
import { mark, tr } from './i18n';

export const PURPOSES: Record<string, { title: string; text: string; caution?: string }> = {
  PLATFORM_PROCESSING: { title: mark('Running your course'), text: mark('We process your learning activity, submissions and results to deliver the programme and keep a trustworthy record of it.'), caution: mark('Withdrawing this may stop parts of the platform from working for you.') },
  AI_TUTOR: { title: mark('AI tutor'), text: mark('Your questions to the AI tutor are processed by an AI service to answer you from your course material.') },
  ANALYTICS: { title: mark('Learning analytics'), text: mark('Your activity is analysed (in aggregate where possible) to improve courses and spot learners who may need support.') },
};

export interface ReqInfo { label: string; tone: 'ok' | 'warn' | 'muted'; blurb: string }
export function describeRequest(r: Pick<PrivacyRequest, 'type' | 'status' | 'exportExpiresAt' | 'decisionReason'>, now = Date.now()): ReqInfo {
  const expired = r.type === 'EXPORT' && !!r.exportExpiresAt && Date.parse(r.exportExpiresAt) < now;
  switch (r.status) {
    case 'REQUESTED': return { label: tr('Waiting for approval'), tone: 'warn', blurb: tr('A member of staff who is not you must approve this request. You will be notified.') };
    case 'APPROVED': return { label: tr('Approved, in the queue'), tone: 'warn', blurb: tr('Approved. It will be carried out shortly.') };
    case 'PROCESSING': return { label: tr('In progress'), tone: 'warn', blurb: tr('Being carried out now.') };
    case 'COMPLETED': return r.type === 'EXPORT' ? (expired ? { label: tr('Expired'), tone: 'muted', blurb: tr('This download has expired. Request a new export if you still need it.') } : { label: tr('Ready'), tone: 'ok', blurb: tr('Your data is ready to download.') }) : { label: tr('Completed'), tone: 'ok', blurb: tr('Done.') };
    case 'REJECTED': return { label: tr('Declined'), tone: 'muted', blurb: r.decisionReason ? tr('Reason: {reason}', { reason: r.decisionReason }) : tr('This request was declined.') };
    case 'BLOCKED': return { label: tr('Could not be completed'), tone: 'warn', blurb: tr('An erasure cannot be completed while you have an active course or a legal hold applies. Contact support to discuss next steps.') };
    default: return { label: r.status.toLowerCase().replace(/_/g, ' '), tone: 'muted', blurb: '' };
  }
}
export const canDownload = (r: Pick<PrivacyRequest, 'type' | 'status' | 'exportExpiresAt'>, now = Date.now()) => r.type === 'EXPORT' && r.status === 'COMPLETED' && !!r.exportExpiresAt && Date.parse(r.exportExpiresAt) > now;
export const typeLabel = (t: string) => { const m = ({ EXPORT: mark('Data download'), CORRECTION: mark('Correction'), ERASURE: mark('Erasure') } as Record<string, string>)[t]; return m ? tr(m) : t; };
/** Whether another request of this type is already in flight (the server allows only one at a time). */
export const hasOpen = (rs: PrivacyRequest[], type: string) => rs.some((r) => r.type === type && ['REQUESTED', 'APPROVED', 'PROCESSING'].includes(r.status));

/** Reflects accessibility preferences on the page itself (WCAG 1.4.12 text spacing, 1.4.3 contrast, 2.3.3 motion, 2.5.5 target size). */
export function applyPrefs(p: Prefs, root: HTMLElement = document.documentElement) {
  root.dataset.contrast = p.highContrast ? 'high' : 'normal'; root.dataset.motion = p.reducedMotion ? 'reduced' : 'normal'; root.dataset.targets = p.largeTargets ? 'large' : 'normal'; root.dataset.spacing = p.textSpacing ?? 'normal';
  root.style.setProperty('--font-scale', String(p.fontScale ?? 1)); root.dataset.captionSize = p.captionSize ?? 'normal'; root.dataset.captionBg = p.captionBackground === false ? 'none' : 'solid';
  if (p.language) root.lang = p.language;
}
export const savePrefsLocal = (p: Prefs) => { try { localStorage.setItem('edtech.prefs', JSON.stringify(p)); if (typeof p.lowBandwidth === 'boolean') localStorage.setItem('edtech.low', p.lowBandwidth ? '1' : '0'); } catch { /* storage blocked */ } };
export const loadPrefsLocal = (): Prefs => { try { return JSON.parse(localStorage.getItem('edtech.prefs') ?? '{}'); } catch { return {}; } };

/** "Chrome on Mac" instead of a raw user-agent string; unknown strings are shortened rather than guessed at. */
export function friendlyDevice(ua?: string | null): string {
  if (!ua) return tr('Unknown device');
  if (/^curl\//i.test(ua)) return tr('Command-line tool');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) || /CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iPhone/iPad' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : null;
  return browser && os ? `${browser} on ${os}` : browser ?? (ua.length > 40 ? `${ua.slice(0, 40)}…` : ua);
}
