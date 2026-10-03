/** The name of each page, by route, for the browser tab and history (WCAG 2.4.2) and for announcing a page change to a screen reader. */
const ROUTES: [RegExp, string][] = [
  [/^\/login$/, 'Sign in'], [/^\/$/, 'My courses'], [/^\/courses\/[^/]+$/, 'Your progress'], [/^\/courses\/[^/]+\/topics\/[^/]+$/, 'Topic'], [/^\/labs$/, 'Labs'], [/^\/labs\/attend$/, 'Lab check-in'], [/^\/labs\/[^/]+$/, 'Lab'],
  [/^\/grades$/, 'Assignment grades'], [/^\/grades\/[^/]+$/, 'Assignment feedback'], [/^\/exams$/, 'Exams'], [/^\/exams\/[^/]+\/check-in\/[^/]+$/, 'Exam check-in'], [/^\/exam-attempts\/[^/]+$/, 'Your exam'], [/^\/exam-results\/[^/]+$/, 'Exam result'],
  [/^\/completion$/, 'Programme completion'], [/^\/tutor$/, 'AI tutor'], [/^\/doubts$/, 'Ask a teacher'], [/^\/notifications$/, 'Notifications'], [/^\/privacy$/, 'Privacy and data'], [/^\/account$/, 'Account and security'],
  [/^\/staff$/, 'Staff console'], [/^\/staff\/admissions$/, 'Admissions'], [/^\/staff\/moderation$/, 'Grading'], [/^\/staff\/moderation\/[^/]+$/, 'Grading case'], [/^\/staff\/labs$/, 'Lab desk'], [/^\/staff\/operations$/, 'Operations'],
  [/^\/staff\/examops$/, 'Exam integrity'], [/^\/staff\/examops\/attempts\/[^/]+$/, 'Exam case'], [/^\/staff\/examops\/exams\/[^/]+\/report$/, 'Exam results report'],
  [/^\/staff\/examsetup$/, 'Exam set-up'], [/^\/staff\/examsetup\/new$/, 'Define an exam'], [/^\/staff\/examsetup\/exams\/[^/]+$/, 'Exam'],
  [/^\/staff\/content$/, 'Content'], [/^\/staff\/content\/versions\/[^/]+$/, 'Programme version'], [/^\/staff\/doubts$/, 'Doubt desk'], [/^\/staff\/doubts\/tickets\/[^/]+$/, 'Ticket'],
  [/^\/staff\/gradechanges$/, 'Grade changes'], [/^\/staff\/gradechanges\/overrides\/[^/]+$/, 'Grade override'], [/^\/staff\/gradechanges\/submissions\/[^/]+$/, 'Grade history'],
  [/^\/staff\/users$/, 'People'], [/^\/staff\/users\/[^/]+$/, 'Person'], [/^\/staff\/privacy$/, 'Privacy'], [/^\/staff\/privacy\/requests\/[^/]+$/, 'Privacy request'], [/^\/staff\/account$/, 'Account and security'],
];
export const APP_NAME = 'Learning Portal';
export const routeTitle = (pathname: string): string => ROUTES.find(([re]) => re.test(pathname.replace(/\/+$/, '') || '/'))?.[1] ?? APP_NAME;
export const documentTitle = (pathname: string) => { const t = routeTitle(pathname); return t === APP_NAME ? APP_NAME : `${t} · ${APP_NAME}`; };
