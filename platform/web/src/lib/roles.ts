/** Which roles see which staff areas. The SERVER enforces every one of these on every request; this only decides what to show. Mirrors platform/docs/guides/api-reference.md. */
export const STAFF_ROLES = ['SUPER_ADMIN', 'PLATFORM_ADMIN', 'ACADEMIC_ADMIN', 'CONTENT_AUTHOR', 'FACULTY_REVIEWER', 'APPROVER_PUBLISHER', 'ASSESSMENT_ADMIN', 'EXAM_ADMIN', 'DOUBT_TEACHER', 'SUPPORT_OPERATOR', 'AUDITOR', 'LAB_COORDINATOR'] as const;
export const hasAny = (roles: readonly string[] | undefined, allowed: readonly string[]) => !!roles?.some((r) => allowed.includes(r));
export const isLearner = (roles?: readonly string[]) => !!roles?.includes('LEARNER');
export const isStaff = (roles?: readonly string[]) => hasAny(roles, STAFF_ROLES);

export const AREAS = {
  admissions: { title: 'Admissions', blurb: 'Review applications and admit learners.', view: ['PLATFORM_ADMIN', 'ACADEMIC_ADMIN', 'SUPER_ADMIN', 'SUPPORT_OPERATOR'], act: ['PLATFORM_ADMIN', 'ACADEMIC_ADMIN'], import: ['PLATFORM_ADMIN', 'ACADEMIC_ADMIN', 'SUPER_ADMIN'] },
  labs: { title: 'Lab desk', blurb: 'Plan sessions, show the check-in code, record attendance.', view: ['LAB_COORDINATOR', 'ACADEMIC_ADMIN'] },
  operations: { title: 'Operations', blurb: 'Integrity checks, audit trail, platform settings.', view: ['PLATFORM_ADMIN', 'SUPER_ADMIN', 'AUDITOR', 'ACADEMIC_ADMIN', 'EXAM_ADMIN', 'ASSESSMENT_ADMIN'] },
} as const;
export const canSee = (roles: readonly string[] | undefined, area: keyof typeof AREAS) => hasAny(roles, AREAS[area].view);
export const INTEGRITY_ROLES = ['PLATFORM_ADMIN', 'SUPER_ADMIN', 'AUDITOR'];
export const CONFIG_ROLES = ['PLATFORM_ADMIN', 'SUPER_ADMIN', 'ACADEMIC_ADMIN'];
export const EXAM_STATUS_ROLES = ['EXAM_ADMIN', 'ASSESSMENT_ADMIN', 'FACULTY_REVIEWER', 'ACADEMIC_ADMIN', 'AUDITOR', 'PLATFORM_ADMIN'];
export const roleLabel = (r: string) => r.toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
