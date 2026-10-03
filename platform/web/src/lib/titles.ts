import { mark, tr } from './i18n';

/** The name of each page, by route, for the browser tab and history (WCAG 2.4.2) and for announcing a page change to a screen reader. */
const ROUTES: [RegExp, string][] = [
  [/^\/login$/, mark('Sign in')], [/^\/sso\/callback$/, mark('Signing you in')], [/^\/downloads$/, mark('My downloads')], [/^\/downloads\/[^/]+$/, mark('Saved lesson')], [/^\/offline$/, mark('My downloads')], [/^\/offline\/[^/]+$/, mark('Saved lesson')],
  [/^\/$/, mark('My courses')], [/^\/courses\/[^/]+$/, mark('Your progress')], [/^\/courses\/[^/]+\/topics\/[^/]+$/, mark('Topic')], [/^\/labs$/, mark('Labs')], [/^\/labs\/attend$/, mark('Lab check-in')], [/^\/labs\/[^/]+$/, mark('Lab')],
  [/^\/grades$/, mark('Assignment grades')], [/^\/grades\/[^/]+$/, mark('Assignment feedback')], [/^\/exams$/, mark('Exams')], [/^\/exams\/[^/]+\/check-in\/[^/]+$/, mark('Exam check-in')], [/^\/exam-attempts\/[^/]+$/, mark('Your exam')], [/^\/exam-results\/[^/]+$/, mark('Exam result')],
  [/^\/completion$/, mark('Programme completion')], [/^\/tutor$/, mark('AI tutor')], [/^\/doubts$/, mark('Ask a teacher')], [/^\/notifications$/, mark('Notifications')], [/^\/privacy$/, mark('Privacy and data')], [/^\/account$/, mark('Account and security')],
];
/** The staff console is English only: its titles are not translated. */
const STAFF_ROUTES: [RegExp, string][] = [
  [/^\/staff$/, 'Staff console'], [/^\/staff\/admissions$/, 'Admissions'], [/^\/staff\/moderation$/, 'Grading'], [/^\/staff\/moderation\/[^/]+$/, 'Grading case'], [/^\/staff\/labs$/, 'Lab desk'], [/^\/staff\/operations$/, 'Operations'],
  [/^\/staff\/examops$/, 'Exam integrity'], [/^\/staff\/examops\/attempts\/[^/]+$/, 'Exam case'], [/^\/staff\/examops\/exams\/[^/]+\/report$/, 'Exam results report'],
  [/^\/staff\/examsetup$/, 'Exam set-up'], [/^\/staff\/examsetup\/new$/, 'Define an exam'], [/^\/staff\/examsetup\/exams\/[^/]+$/, 'Exam'],
  [/^\/staff\/content$/, 'Content'], [/^\/staff\/content\/versions\/[^/]+$/, 'Programme version'], [/^\/staff\/doubts$/, 'Doubt desk'], [/^\/staff\/doubts\/tickets\/[^/]+$/, 'Ticket'],
  [/^\/staff\/gradechanges$/, 'Grade changes'], [/^\/staff\/gradechanges\/overrides\/[^/]+$/, 'Grade override'], [/^\/staff\/gradechanges\/submissions\/[^/]+$/, 'Grade history'],
  [/^\/staff\/users$/, 'People'], [/^\/staff\/users\/[^/]+$/, 'Person'], [/^\/staff\/privacy$/, 'Privacy'], [/^\/staff\/privacy\/requests\/[^/]+$/, 'Privacy request'],
  [/^\/staff\/entitlements$/, 'Entitlements'], [/^\/staff\/entitlements\/[^/]+$/, 'Entitlement'], [/^\/staff\/reports$/, 'Reports'], [/^\/staff\/account$/, 'Account and security'],
];
export const APP_NAME = 'Learning Portal';
export const routeTitle = (pathname: string): string => {
  const p = pathname.replace(/\/+$/, '') || '/'; const staff = STAFF_ROUTES.find(([re]) => re.test(p))?.[1]; if (staff) return staff;
  const t = ROUTES.find(([re]) => re.test(p))?.[1]; return t ? tr(t) : tr(APP_NAME);
};
export const documentTitle = (pathname: string) => { const t = routeTitle(pathname); return t === tr(APP_NAME) ? tr(APP_NAME) : `${t} · ${tr(APP_NAME)}`; };
