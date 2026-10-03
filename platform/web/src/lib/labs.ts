import type { LabActivity, LabBookingInfo } from '../api/types';
import { localeOf, tr } from './i18n';

export type LabState = 'completed' | 'awaiting-evidence' | 'attended' | 'booked' | 'ready' | 'blocked';
export interface LabStatus { state: LabState; label: string; tone: 'ok' | 'warn' | 'muted' }

/** The live booking is the one that is not cancelled or missed; completion outranks everything. */
export const liveBooking = (a: Pick<LabActivity, 'bookings'>): LabBookingInfo | undefined => a.bookings.find((b) => b.status === 'BOOKED' || b.status === 'ATTENDED');

export function labStatus(a: LabActivity): LabStatus {
  if (a.completed) return { state: 'completed', label: tr('Completed'), tone: 'ok' };
  const b = liveBooking(a);
  if (b?.status === 'ATTENDED') return a.requireEvidence && !b.evidenceSubmitted ? { state: 'awaiting-evidence', label: tr('Evidence needed'), tone: 'warn' } : { state: 'attended', label: tr('Attended, awaiting completion'), tone: 'warn' };
  if (b?.status === 'BOOKED') return { state: 'booked', label: tr('Booked'), tone: 'warn' };
  return a.eligibility.eligible ? { state: 'ready', label: tr('Ready to book'), tone: 'muted' } : { state: 'blocked', label: tr('Not ready yet'), tone: 'muted' };
}

/** Plain-language reasons a lab cannot be booked yet (the server re-checks every one). */
export const prerequisiteBlockers = (a: LabActivity, topicTitles: Map<string, string>): string[] => a.eligibility.missingPrerequisiteTopics.map((id) => tr('Complete the topic "{title}" first.', { title: topicTitles.get(id) ?? tr('a prerequisite topic') }));
export function blockers(a: LabActivity, topicTitles: Map<string, string>): string[] {
  const out = prerequisiteBlockers(a, topicTitles);
  if (!a.eligibility.safetyAcknowledged) out.push(tr('Read and accept the safety notice.'));
  return out;
}

/** Attendance by QR opens 15 minutes before the slot and closes when it ends (the server enforces this; the client only explains it). */
export function attendanceWindow(slot: { startsAt: string; endsAt: string }, now = Date.now()): { open: boolean; text: string } {
  const start = Date.parse(slot.startsAt), end = Date.parse(slot.endsAt), opens = start - 15 * 60_000;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { open: false, text: '' };
  if (now > end) return { open: false, text: tr('This session has ended.') };
  if (now < opens) return { open: false, text: tr('Check-in opens at {time}.', { time: new Date(opens).toLocaleString(localeOf(), { dateStyle: 'medium', timeStyle: 'short' }) }) };
  return { open: true, text: tr('Check-in is open. Scan or enter the code shown by the lab coordinator.') };
}

/** Pulls the code out of a pasted QR link (`.../labs/attend?token=...`) or accepts a bare code. */
export function tokenFromInput(raw: string): string {
  const t = raw.trim(); if (!t) return '';
  try { const u = new URL(t); const q = u.searchParams.get('token'); if (q) return q; } catch { /* not a URL */ }
  return t;
}
export const looksLikeUrl = (s: string | undefined) => !!s && /^https?:\/\/\S+$/i.test(s.trim());
export const slotTime = (s: { startsAt: string; endsAt: string }) => tr('{from} to {to}', { from: new Date(s.startsAt).toLocaleString(localeOf(), { dateStyle: 'medium', timeStyle: 'short' }), to: new Date(s.endsAt).toLocaleTimeString(localeOf(), { timeStyle: 'short' }) });
