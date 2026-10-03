import { lazy, Suspense } from 'react';
import { Navigate, Route } from 'react-router-dom';
import { Loading } from '../components/ui';
const StaffShell = lazy(() => import('./StaffShell'));
const StaffHome = lazy(() => import('./StaffHome'));
const Admissions = lazy(() => import('./Admissions'));
const LabDesk = lazy(() => import('./LabDesk'));
const Operations = lazy(() => import('./Operations'));
const Moderation = lazy(() => import('./Moderation'));
const ModerationCase = lazy(() => import('./ModerationCase'));
const ExamOps = lazy(() => import('./ExamOps'));
const ExamReport = lazy(() => import('./ExamReport'));
const ExamCase = lazy(() => import('./ExamCase'));
const Content = lazy(() => import('./Content'));
const ContentVersion = lazy(() => import('./ContentVersion'));
const Doubts = lazy(() => import('./Doubts'));
const DoubtTicket = lazy(() => import('./DoubtTicket'));
const Users = lazy(() => import('./Users'));
const UserDetail = lazy(() => import('./UserDetail'));
const PrivacyDesk = lazy(() => import('./PrivacyDesk'));
const PrivacyRequest = lazy(() => import('./PrivacyRequest'));
const ExamSetup = lazy(() => import('./ExamSetup'));
const ExamNew = lazy(() => import('./ExamNew'));
const ExamDefinition = lazy(() => import('./ExamDefinition'));
const GradeChanges = lazy(() => import('./GradeChanges'));
const OverrideCase = lazy(() => import('./OverrideCase'));
const SubmissionHistory = lazy(() => import('./SubmissionHistory'));
const Entitlements = lazy(() => import('./Entitlements'));
const EntitlementDetail = lazy(() => import('./EntitlementDetail'));
const Reports = lazy(() => import('./Reports'));
const Account = lazy(() => import('../pages/Account'));

/** Everything under /staff. Each page also checks the role (and the API checks it again on every call). */
export default function StaffRoutes() {
  return (
    <Route path="staff" element={<Suspense fallback={<Loading />}><StaffShell /></Suspense>}>
      <Route index element={<StaffHome />} />
      <Route path="admissions" element={<Admissions />} />
      <Route path="moderation" element={<Moderation />} />
      <Route path="moderation/:taskId" element={<ModerationCase />} />
      <Route path="content" element={<Content />} />
      <Route path="content/versions/:versionId" element={<ContentVersion />} />
      <Route path="examops" element={<ExamOps />} />
      <Route path="examops/attempts/:attemptId" element={<ExamCase />} />
      <Route path="examops/exams/:examId/report" element={<ExamReport />} />
      <Route path="doubts" element={<Doubts />} />
      <Route path="doubts/tickets/:ticketId" element={<DoubtTicket />} />
      <Route path="users" element={<Users />} />
      <Route path="users/:userId" element={<UserDetail />} />
      <Route path="privacy" element={<PrivacyDesk />} />
      <Route path="privacy/requests/:requestId" element={<PrivacyRequest />} />
      <Route path="examsetup" element={<ExamSetup />} />
      <Route path="examsetup/new" element={<ExamNew />} />
      <Route path="examsetup/exams/:examId" element={<ExamDefinition />} />
      <Route path="gradechanges" element={<GradeChanges />} />
      <Route path="gradechanges/overrides/:overrideId" element={<OverrideCase />} />
      <Route path="gradechanges/submissions/:submissionId" element={<SubmissionHistory />} />
      <Route path="entitlements" element={<Entitlements />} />
      <Route path="entitlements/:entitlementId" element={<EntitlementDetail />} />
      <Route path="reports" element={<Reports />} />
      <Route path="labs" element={<LabDesk />} />
      <Route path="operations" element={<Operations />} />
      <Route path="account" element={<Account />} />
      <Route path="*" element={<Navigate to="/staff" replace />} />
    </Route>
  );
}
