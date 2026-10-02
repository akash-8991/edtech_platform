import { Policy } from './policy';

export const addMonths = (d: Date, m: number): Date => {
  const r = new Date(d);
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + m);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
};

export const daysBetween = (a: Date, b: Date): number =>
  Math.max(0, Math.ceil((b.getTime() - a.getTime()) / 86_400_000));

export interface EntState {
  status: 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'REVOKED';
  startAt: Date; endAt: Date;
  pauseCount: number; pausedDays: number; pausedAt: Date | null;
}

export class PolicyError extends Error {}

/** Access starts at activation; end date fixed from start (build prompt). */
export const computeEnd = (start: Date, d: 'M12' | 'M18', p: Policy) => addMonths(start, p.durationMonths[d]);

export function canPause(e: EntState, now: Date, p: Policy): void {
  if (e.status !== 'ACTIVE') throw new PolicyError(`cannot pause from ${e.status}`);
  if (now >= e.endAt) throw new PolicyError('entitlement expired');
  if (e.pauseCount >= p.maxPauses) throw new PolicyError('pause count limit reached');
  if (e.pausedDays >= p.maxPausedDays) throw new PolicyError('cumulative pause days exhausted');
}

/** Resume: pause consumes balance but NEVER extends endAt (extension only via recorded exception). */
export function resumeResult(e: EntState, now: Date, p: Policy) {
  if (e.status !== 'PAUSED' || !e.pausedAt) throw new PolicyError('not paused');
  const used = daysBetween(e.pausedAt, now);
  return { pausedDays: Math.min(p.maxPausedDays, e.pausedDays + used), usedThisPause: used };
}

/** Effective status at `now`; pause does not stop the clock. Expiry removes normal access. */
export function effectiveStatus(e: EntState, now: Date): EntState['status'] {
  if (e.status === 'REVOKED') return 'REVOKED';
  return now >= e.endAt ? 'EXPIRED' : e.status;
}

export const hasLearningAccess = (e: EntState, now: Date) => effectiveStatus(e, now) === 'ACTIVE';
