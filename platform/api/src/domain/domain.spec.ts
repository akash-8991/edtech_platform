import { addMonths, canPause, computeEnd, effectiveStatus, hasLearningAccess, PolicyError, resumeResult } from './entitlement';
import { defaultPolicy } from './policy';
import { authorize, WorkflowError } from './workflow';
import { chainHash, GENESIS, verifyChain } from './audit-chain';

const p = defaultPolicy();
const ent = (o: any = {}) => ({ status: 'ACTIVE' as const, startAt: new Date('2026-01-31'), endAt: new Date('2027-01-31'),
  pauseCount: 0, pausedDays: 0, pausedAt: null, ...o });

describe('entitlement', () => {
  it('12/18 month end dates, month-end safe', () => {
    expect(computeEnd(new Date('2026-01-31T00:00:00Z'), 'M12', p).toISOString()).toBe('2027-01-31T00:00:00.000Z');
    expect(addMonths(new Date('2026-08-31T00:00:00Z'), 6).toISOString()).toBe('2027-02-28T00:00:00.000Z');
  });
  it('pause limits enforced', () => {
    expect(() => canPause(ent({ pauseCount: 2 }), new Date('2026-03-01'), p)).toThrow(PolicyError);
    expect(() => canPause(ent({ pausedDays: 60 }), new Date('2026-03-01'), p)).toThrow(PolicyError);
    expect(() => canPause(ent({ status: 'PAUSED' }), new Date('2026-03-01'), p)).toThrow(PolicyError);
    expect(() => canPause(ent(), new Date('2026-03-01'), p)).not.toThrow();
  });
  it('resume consumes balance but has no endAt in result (no extension)', () => {
    const r = resumeResult(ent({ status: 'PAUSED', pausedAt: new Date('2026-03-01') }), new Date('2026-03-11'), p);
    expect(r.pausedDays).toBe(10);
    expect(Object.keys(r)).not.toContain('endAt');
  });
  it('expiry removes access even while paused', () => {
    const e = ent({ status: 'PAUSED' });
    expect(effectiveStatus(e, new Date('2027-02-01'))).toBe('EXPIRED');
    expect(hasLearningAccess(ent(), new Date('2026-06-01'))).toBe(true);
    expect(hasLearningAccess(e, new Date('2026-06-01'))).toBe(false);
  });
});

describe('workflow', () => {
  const base = { authorId: 'a', facultyReviewerIds: ['f'] };
  it('no direct publication', () => {
    expect(() => authorize('DRAFT', 'PUBLISHED', { ...base, actorId: 'x', actorRoles: ['APPROVER_PUBLISHER'] }, p)).toThrow(WorkflowError);
  });
  it('author cannot approve own work; super admin has no bypass', () => {
    expect(() => authorize('FACULTY_REVIEW', 'FACULTY_APPROVED', { ...base, actorId: 'a', actorRoles: ['FACULTY_REVIEWER'] }, p)).toThrow(/segregation/);
    expect(() => authorize('ADMIN_APPROVAL', 'PUBLISHED', { ...base, actorId: 's', actorRoles: ['SUPER_ADMIN'] }, p)).toThrow(WorkflowError);
  });
  it('faculty reviewer cannot also publish; independent approver can', () => {
    expect(() => authorize('ADMIN_APPROVAL', 'PUBLISHED', { ...base, actorId: 'f', actorRoles: ['APPROVER_PUBLISHER'] }, p)).toThrow(/segregation/);
    expect(() => authorize('ADMIN_APPROVAL', 'PUBLISHED', { ...base, actorId: 'z', actorRoles: ['APPROVER_PUBLISHER'] }, p)).not.toThrow();
  });
  it('send-back and retire need a reason', () => {
    expect(() => authorize('FACULTY_REVIEW', 'DRAFT', { ...base, actorId: 'f', actorRoles: ['FACULTY_REVIEWER'] }, p)).toThrow(/reason/);
    expect(() => authorize('PUBLISHED', 'RETIRED', { ...base, actorId: 'z', actorRoles: ['APPROVER_PUBLISHER'], reason: 'superseded' }, p)).not.toThrow();
  });
});

describe('audit chain', () => {
  it('detects tampering', () => {
    const rows: any[] = []; let prev = GENESIS;
    for (const payload of [{ a: 1 }, { b: 2 }, { c: 3 }]) { const hash = chainHash(prev, payload); rows.push({ prevHash: prev, hash, payload }); prev = hash; }
    expect(verifyChain(rows)).toBeNull();
    rows[1].payload = { b: 999 };
    expect(verifyChain(rows)).toBe(1);
  });
});
