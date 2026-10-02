import type { LabActivity, LabBookingInfo } from '../api/types';

export type LabState = 'completed' | 'awaiting-evidence' | 'attended' | 'booked' | 'ready' | 'blocked';
export interface LabStatus { state: LabState; label: string; tone: 'ok' | 'warn' | 'muted' }

/** The live booking is the one that is not cancelled or missed; completion outranks everything. */
export const liveBooking = (a: Pick<LabActivity, 'bookings'>): LabBookingInfo | undefined => a.bookings.find((b) => b.status === 'BOOKED' || b.status === 'ATTENDED');

export function labStatus(a: LabActivity): LabStatus {
  if (a.completed) return { state: 'completed', label: 'Completed', tone: 'ok' };
  const b = liveBooking(a);
  if (b?.status === 'ATTENDED') return a.requireEvidence && !b.evidenceSubmitted ? { state: 'awaiting-evidence', label: 'Evidence needed', tone: 'warn' } : { state: 'attended', label: 'Attended, awaiting completion', tone: 'warn' };
  if (b?.status === 'BOOKED') return { state: 'booked', label: 'Booked', tone: 'warn' };
  return a.eligibility.eligible ? { state: 'ready', label: 'Ready to book', tone: 'muted' } : { state: 'blocked', label: 'Not ready yet', tone: 'muted' };
}

/** Plain-language reasons a lab cannot be booked yet (the server re-checks every one). */
export function blockers(a: LabActivity, topicTitles: Map<string, string>): string[] {
  const out: string[] = [];
  for (const id of a.eligibility.missingPrerequisiteTopics) out.push(`Complete the topic "${topicTitles.get(id) ?? 'a prerequisite topic'}" first.`);
  if (!a.eligibility.safetyAcknowledged) out.push('Read and accept the safety notice.');
  return out;
}

/** Attendance by QR opens 15 minutes before the slot and closes when it ends (the server enforces this; the client only explains it). */
export function attendanceWindow(slot: { startsAt: string; endsAt: string }, now = Date.now()): { open: boolean; text: string } {
  const start = Date.parse(slot.startsAt), end = Date.parse(slot.endsAt), opens = start - 15 * 60_000;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { open: false, text: '' };
  if (now > end) return { open: false, text: 'This session has ended.' };
  if (now < opens) return { open: false, text: `Check-in opens at ${new Date(opens).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.` };
  return { open: true, text: 'Check-in is open. Scan or enter the code shown by the lab coordinator.' };
}

/** Pulls the code out of a pasted QR link (`.../labs/attend?token=...`) or accepts a bare code. */
export function tokenFromInput(raw: string): string {
  const t = raw.trim(); if (!t) return '';
  try { const u = new URL(t); const q = u.searchParams.get('token'); if (q) return q; } catch { /* not a URL */ }
  return t;
}
export const looksLikeUrl = (s: string | undefined) => !!s && /^https?:\/\/\S+$/i.test(s.trim());
export const slotTime = (s: { startsAt: string; endsAt: string }) => `${new Date(s.startsAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} to ${new Date(s.endsAt).toLocaleTimeString(undefined, { timeStyle: 'short' })}`;
