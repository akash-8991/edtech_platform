/** Which roles see which staff areas. The SERVER enforces every one of these on every request; this only decides what to show. Mirrors platform/docs/guides/api-reference.md. */
export const STAFF_ROLES = ['SUPER_ADMIN', 'PLATFORM_ADMIN', 'ACADEMIC_ADMIN', 'CONTENT_AUTHOR', 'FACULTY_REVIEWER', 'APPROVER_PUBLISHER', 'ASSESSMENT_ADMIN', 'EXAM_ADMIN', 'DOUBT_TEACHER', 'SUPPORT_OPERATOR', 'AUDITOR', 'LAB_COORDINATOR'] as const;
export const hasAny = (roles: readonly string[] | undefined, allowed: readonly string[]) => !!roles?.some((r) => allowed.includes(r));
export const isLearner = (roles?: readonly string[]) => !!roles?.includes('LEARNER');
export const isStaff = (roles?: readonly string[]) => hasAny(roles, STAFF_ROLES);

export const AREAS = {
  admissions: { title: 'Admissions', blurb: 'Review applications and admit learners.', view: ['PLATFORM_ADMIN', 'ACADEMIC_ADMIN', 'SUPER_ADMIN', 'SUPPORT_OPERATOR'], act: ['PLATFORM_ADMIN', 'ACADEMIC_ADMIN'], import: ['PLATFORM_ADMIN', 'ACADEMIC_ADMIN', 'SUPER_ADMIN'] },
  moderation: { title: 'Grading', blurb: 'Review assignments that need a person, and decide appeals.', view: ['FACULTY_REVIEWER', 'ASSESSMENT_ADMIN', 'ACADEMIC_ADMIN', 'AUDITOR', 'PLATFORM_ADMIN'], act: ['FACULTY_REVIEWER', 'ASSESSMENT_ADMIN'] },
  examops: { title: 'Exam integrity', blurb: 'Review incidents and appeals, decide outcomes, and release results.', view: ['EXAM_ADMIN', 'ASSESSMENT_ADMIN', 'FACULTY_REVIEWER', 'ACADEMIC_ADMIN', 'AUDITOR', 'PLATFORM_ADMIN'], act: ['FACULTY_REVIEWER', 'ASSESSMENT_ADMIN'] },
  content: { title: 'Content', blurb: 'Write programmes, quizzes and assignments, and take them through review to publication.', view: ['CONTENT_AUTHOR', 'ACADEMIC_ADMIN', 'FACULTY_REVIEWER', 'APPROVER_PUBLISHER', 'AUDITOR', 'SUPER_ADMIN'], act: ['CONTENT_AUTHOR', 'ACADEMIC_ADMIN'] },
  doubts: { title: 'Doubt desk', blurb: "Answer learners' questions, review reusable answers, and keep replies on time.", view: ['DOUBT_TEACHER', 'SUPPORT_OPERATOR', 'ACADEMIC_ADMIN', 'PLATFORM_ADMIN', 'FACULTY_REVIEWER', 'AUDITOR'], act: ['DOUBT_TEACHER'] },
  users: { title: 'People', blurb: 'Find people, create accounts, change roles, suspend or unlock, reset passwords.', view: ['SUPER_ADMIN', 'PLATFORM_ADMIN', 'AUDITOR', 'SUPPORT_OPERATOR'], act: ['SUPER_ADMIN', 'PLATFORM_ADMIN'] },
  privacy: { title: 'Privacy', blurb: "Decide people's requests to see, correct or erase their data; run retention.", view: ['PLATFORM_ADMIN', 'SUPER_ADMIN', 'SUPPORT_OPERATOR', 'AUDITOR'], act: ['PLATFORM_ADMIN', 'SUPER_ADMIN'] },
  examsetup: { title: 'Exam set-up', blurb: 'Define and publish exams, keep the question bank, schedule sittings, grant accommodations.', view: ['EXAM_ADMIN', 'ASSESSMENT_ADMIN', 'ACADEMIC_ADMIN', 'AUDITOR'], act: ['EXAM_ADMIN', 'ASSESSMENT_ADMIN'] },
  entitlements: { title: 'Entitlements', blurb: 'Find a learner\'s access, pause or extend it, revoke it, or unlock a topic.', view: ['SUPER_ADMIN', 'PLATFORM_ADMIN', 'ACADEMIC_ADMIN', 'SUPPORT_OPERATOR', 'AUDITOR'], act: ['PLATFORM_ADMIN', 'ACADEMIC_ADMIN', 'SUPPORT_OPERATOR'] },
  reports: { title: 'Reports', blurb: 'Progress, exams, grading, doubts and tutor use, with CSV export for progress.', view: ['ACADEMIC_ADMIN', 'PLATFORM_ADMIN', 'SUPPORT_OPERATOR', 'AUDITOR', 'SUPER_ADMIN', 'ASSESSMENT_ADMIN', 'EXAM_ADMIN', 'FACULTY_REVIEWER'] },
  gradechanges: { title: 'Grade changes', blurb: 'Change a grade with two people: one proposes, a different one approves.', view: ['ACADEMIC_ADMIN', 'ASSESSMENT_ADMIN', 'AUDITOR', 'PLATFORM_ADMIN'], act: ['ACADEMIC_ADMIN', 'ASSESSMENT_ADMIN'] },
  labs: { title: 'Lab desk', blurb: 'Plan sessions, show the check-in code, record attendance.', view: ['LAB_COORDINATOR', 'ACADEMIC_ADMIN'] },
  operations: { title: 'Operations', blurb: 'Integrity checks, audit trail, platform settings.', view: ['PLATFORM_ADMIN', 'SUPER_ADMIN', 'AUDITOR', 'ACADEMIC_ADMIN', 'EXAM_ADMIN', 'ASSESSMENT_ADMIN'] },
} as const;
export const canSee = (roles: readonly string[] | undefined, area: keyof typeof AREAS) => hasAny(roles, AREAS[area].view);
export const INTEGRITY_ROLES = ['PLATFORM_ADMIN', 'SUPER_ADMIN', 'AUDITOR'];
export const CONFIG_ROLES = ['PLATFORM_ADMIN', 'SUPER_ADMIN', 'ACADEMIC_ADMIN'];
export const EXAM_STATUS_ROLES = ['EXAM_ADMIN', 'ASSESSMENT_ADMIN', 'FACULTY_REVIEWER', 'ACADEMIC_ADMIN', 'AUDITOR', 'PLATFORM_ADMIN'];
export const roleLabel = (r: string) => r.toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
/** Exam-operations actions, one list per server rule. */
export const EXAMOPS = { caseView: ['FACULTY_REVIEWER', 'ASSESSMENT_ADMIN', 'EXAM_ADMIN', 'AUDITOR'], adjudicate: ['FACULTY_REVIEWER', 'ASSESSMENT_ADMIN'], release: ['ASSESSMENT_ADMIN', 'ACADEMIC_ADMIN'], proctor: ['EXAM_ADMIN', 'ASSESSMENT_ADMIN'], evidence: ['FACULTY_REVIEWER', 'ASSESSMENT_ADMIN', 'EXAM_ADMIN'] } as const;
/** Doubt-desk actions, one list per server rule. */
export const DOUBTS = { tickets: ['DOUBT_TEACHER', 'SUPPORT_OPERATOR', 'ACADEMIC_ADMIN', 'PLATFORM_ADMIN'], staff: ['SUPPORT_OPERATOR', 'ACADEMIC_ADMIN', 'PLATFORM_ADMIN'], faqRead: ['FACULTY_REVIEWER', 'ACADEMIC_ADMIN', 'DOUBT_TEACHER', 'AUDITOR'], faqReview: ['FACULTY_REVIEWER', 'ACADEMIC_ADMIN'], teachersRead: ['ACADEMIC_ADMIN', 'PLATFORM_ADMIN', 'SUPPORT_OPERATOR'], teachersEdit: ['ACADEMIC_ADMIN', 'PLATFORM_ADMIN'], report: ['ACADEMIC_ADMIN', 'AUDITOR', 'PLATFORM_ADMIN', 'SUPER_ADMIN', 'SUPPORT_OPERATOR'], teacher: ['DOUBT_TEACHER'] } as const;
export const USERS = { write: ['SUPER_ADMIN', 'PLATFORM_ADMIN'], mfaReset: ['SUPER_ADMIN', 'PLATFORM_ADMIN'], signOut: ['SUPER_ADMIN', 'PLATFORM_ADMIN', 'SUPPORT_OPERATOR'] } as const;
export const PRIVACY = { decide: ['PLATFORM_ADMIN', 'SUPER_ADMIN'], file: ['SUPPORT_OPERATOR', 'PLATFORM_ADMIN', 'SUPER_ADMIN'] } as const;
export const EXAMSETUP = { author: ['EXAM_ADMIN', 'ASSESSMENT_ADMIN'], publish: ['EXAM_ADMIN', 'ASSESSMENT_ADMIN'], bank: ['EXAM_ADMIN', 'ASSESSMENT_ADMIN'], accommodate: ['EXAM_ADMIN', 'ASSESSMENT_ADMIN'], override: ['ASSESSMENT_ADMIN', 'ACADEMIC_ADMIN'], create: ['EXAM_ADMIN', 'ASSESSMENT_ADMIN'] } as const;
export const GRADECHANGES = { act: ['ACADEMIC_ADMIN', 'ASSESSMENT_ADMIN'] } as const;
/** Entitlement actions, one list per server rule (entitlements.ts, learning.ts). */
export const ENTITLEMENTS = { pause: ['PLATFORM_ADMIN', 'ACADEMIC_ADMIN', 'SUPPORT_OPERATOR'], extend: ['PLATFORM_ADMIN', 'ACADEMIC_ADMIN'], revoke: ['PLATFORM_ADMIN', 'ACADEMIC_ADMIN'], override: ['PLATFORM_ADMIN', 'ACADEMIC_ADMIN'] } as const;
export const REPORTS = { progress: ['ACADEMIC_ADMIN', 'PLATFORM_ADMIN', 'SUPPORT_OPERATOR', 'AUDITOR'], exams: ['ACADEMIC_ADMIN', 'ASSESSMENT_ADMIN', 'AUDITOR', 'EXAM_ADMIN', 'FACULTY_REVIEWER', 'PLATFORM_ADMIN'], grading: ['ACADEMIC_ADMIN', 'ASSESSMENT_ADMIN', 'AUDITOR', 'PLATFORM_ADMIN'],
  doubts: ['ACADEMIC_ADMIN', 'AUDITOR', 'PLATFORM_ADMIN', 'SUPER_ADMIN', 'SUPPORT_OPERATOR'], tutor: ['ACADEMIC_ADMIN', 'AUDITOR', 'PLATFORM_ADMIN', 'SUPER_ADMIN', 'SUPPORT_OPERATOR'] } as const;
