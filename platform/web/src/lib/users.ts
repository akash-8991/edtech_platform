/** Roles in plain words (what the role lets someone do in this platform). The server enforces everything; this is for choosing. */
export const ROLE_INFO: [string, string][] = [
  ['SUPER_ADMIN', 'Full control, including other administrators'], ['PLATFORM_ADMIN', 'Runs the platform: people, settings, integrity checks, privacy'], ['ACADEMIC_ADMIN', 'Runs programmes: admissions, content, labs, exam oversight'],
  ['CONTENT_AUTHOR', 'Writes courses, quizzes and assignments'], ['FACULTY_REVIEWER', 'Reviews content, grades and integrity cases'], ['APPROVER_PUBLISHER', 'Gives final approval and publishes courses'],
  ['ASSESSMENT_ADMIN', 'Runs exams, decides integrity cases and releases results'], ['EXAM_ADMIN', 'Sets up exams and supervises sittings'], ['DOUBT_TEACHER', "Answers learners' questions"],
  ['SUPPORT_OPERATOR', 'Helps learners; sees requests and tickets'], ['AUDITOR', 'Read-only oversight'], ['LAB_COORDINATOR', 'Runs lab sessions'], ['LEARNER', 'Takes courses'],
];
export const TOP_ROLES = ['SUPER_ADMIN', 'PLATFORM_ADMIN'];
export const roleInfo = (r: string) => ROLE_INFO.find(([k]) => k === r)?.[1] ?? '';
export const userStatusLabel = (s: string) => ({ ACTIVE: 'Active', SUSPENDED: 'Suspended', ERASED: 'Erased' } as Record<string, string>)[s] ?? s;
export const isSuper = (roles: readonly string[]) => roles.includes('SUPER_ADMIN');

/** Whether this actor may grant or remove a role (only a super admin touches the two administrator roles). */
export const mayGrant = (actorRoles: readonly string[], role: string) => !TOP_ROLES.includes(role) || isSuper(actorRoles);
/** Whether this actor may manage a person at all (a person who holds an administrator role is a super admin's to change). */
export const mayManage = (actorRoles: readonly string[], targetRoles: readonly string[]) => isSuper(actorRoles) || !targetRoles.some((r) => TOP_ROLES.includes(r));
export function roleChange(current: string[], selected: string[]) { return { add: selected.filter((r) => !current.includes(r)), remove: current.filter((r) => !selected.includes(r)) }; }
export const changeProblem = (current: string[], selected: string[], reason: string): string | null => {
  const { add, remove } = roleChange(current, selected);
  if (!add.length && !remove.length) return 'Nothing has changed.'; if (!selected.length) return 'They must keep at least one role. To stop them signing in, suspend the account instead.';
  return reason.trim() ? null : 'Write the reason: it is recorded in the audit trail.';
};
export function validateNewUser(f: { email: string; name: string; roles: string[] }): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) return 'Enter a valid email address.'; if (!f.name.trim()) return 'Enter their name.'; if (f.name.trim().length > 120) return 'The name is too long (120 characters at most).';
  return f.roles.length ? null : 'Choose at least one role.';
}
export const actionLabel = (a: string) => ({ 'user.created': 'Account created', 'user.roles_changed': 'Roles changed', 'user.suspended': 'Suspended', 'user.reactivated': 'Reactivated', 'user.unlocked': 'Unlocked', 'user.password_reset_by_admin': 'Password reset by an administrator', 'auth.mfa_reset': 'Two-step verification reset', 'auth.sessions_revoked_by_admin': 'Signed out everywhere by an administrator', 'auth.password_changed': 'Changed their own password', 'user.provisioned_by_script': 'Account created by the setup script' } as Record<string, string>)[a] ?? a.replace(/[._]/g, ' ');
export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');
