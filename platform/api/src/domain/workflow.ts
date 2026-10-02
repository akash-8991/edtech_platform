import { Policy } from './policy';

export type State = 'DRAFT' | 'FACULTY_REVIEW' | 'FACULTY_APPROVED' | 'ADMIN_APPROVAL' | 'PUBLISHED' | 'RETIRED';
export type Role = string;

interface Rule { from: State; to: State; roles: Role[]; reasonRequired?: boolean; sod?: ('author' | 'facultyReviewer')[] }

// REV-001 state machine. Direct DRAFT -> PUBLISHED is impossible by construction (REV-002).
export const RULES: Rule[] = [
  { from: 'DRAFT', to: 'FACULTY_REVIEW', roles: ['CONTENT_AUTHOR', 'ACADEMIC_ADMIN'] },
  { from: 'FACULTY_REVIEW', to: 'FACULTY_APPROVED', roles: ['FACULTY_REVIEWER'], sod: ['author'] },
  { from: 'FACULTY_REVIEW', to: 'DRAFT', roles: ['FACULTY_REVIEWER'], reasonRequired: true },       // send back
  { from: 'FACULTY_APPROVED', to: 'ADMIN_APPROVAL', roles: ['FACULTY_REVIEWER', 'ACADEMIC_ADMIN'] },
  { from: 'ADMIN_APPROVAL', to: 'PUBLISHED', roles: ['APPROVER_PUBLISHER'], sod: ['author', 'facultyReviewer'] },
  { from: 'ADMIN_APPROVAL', to: 'DRAFT', roles: ['APPROVER_PUBLISHER'], reasonRequired: true },     // reject
  { from: 'PUBLISHED', to: 'RETIRED', roles: ['APPROVER_PUBLISHER', 'ACADEMIC_ADMIN'], reasonRequired: true },
];

export class WorkflowError extends Error {}
/** Role / segregation-of-duties violations (HTTP 403) as opposed to an illegal state move (HTTP 409). */
export class WorkflowForbidden extends WorkflowError {}

export interface Ctx {
  actorId: string; actorRoles: Role[]; authorId: string;
  facultyReviewerIds: string[]; reason?: string;
}

export function authorize(from: State, to: State, c: Ctx, p: Policy): Rule {
  const rule = RULES.find((r) => r.from === from && r.to === to);
  if (!rule) throw new WorkflowError(`transition ${from} -> ${to} is not allowed`);
  // SUPER_ADMIN gets no bypass of maker-checker.
  if (!rule.roles.some((r) => c.actorRoles.includes(r)))
    throw new WorkflowForbidden(`role not permitted for ${from} -> ${to}`);
  if (rule.reasonRequired && !c.reason?.trim()) throw new WorkflowError('reason is required');
  if (p.segregationOfDuties && rule.sod) {
    if (rule.sod.includes('author') && c.actorId === c.authorId)
      throw new WorkflowForbidden('segregation of duties: author cannot approve own content');
    if (rule.sod.includes('facultyReviewer') && c.facultyReviewerIds.includes(c.actorId))
      throw new WorkflowForbidden('segregation of duties: faculty reviewer cannot also give admin approval');
  }
  return rule;
}

export const isEditable = (s: State) => s === 'DRAFT'; // published/approved versions are immutable
