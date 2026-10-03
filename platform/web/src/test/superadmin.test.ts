import { describe, expect, it } from 'vitest';
import { AREAS, canSee, hasAny, isStaff } from '../lib/roles';

describe('super admin', () => {
  it('sees every staff area and passes every role check', () => {
    for (const k of Object.keys(AREAS) as (keyof typeof AREAS)[]) expect(canSee(['SUPER_ADMIN'], k)).toBe(true);
    expect(hasAny(['SUPER_ADMIN'], ['EXAM_ADMIN'])).toBe(true);
    expect(isStaff(['SUPER_ADMIN'])).toBe(true);
  });
  it('other roles are unchanged', () => {
    expect(hasAny(['CONTENT_AUTHOR'], ['EXAM_ADMIN'])).toBe(false);
    expect(canSee(['AUDITOR'], 'users')).toBe(true);
    expect(canSee(['LEARNER'], 'content')).toBe(false);
  });
});
