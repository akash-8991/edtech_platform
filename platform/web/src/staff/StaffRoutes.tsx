import { Navigate, Route } from 'react-router-dom';
import StaffShell from './StaffShell';
import StaffHome from './StaffHome';
import Admissions from './Admissions';
import LabDesk from './LabDesk';
import Operations from './Operations';
import Moderation from './Moderation';
import ModerationCase from './ModerationCase';
import ExamOps from './ExamOps';
import ExamCase from './ExamCase';
import Account from '../pages/Account';

/** Everything under /staff. Each page also checks the role (and the API checks it again on every call). */
export default function StaffRoutes() {
  return (
    <Route path="staff" element={<StaffShell />}>
      <Route index element={<StaffHome />} />
      <Route path="admissions" element={<Admissions />} />
      <Route path="moderation" element={<Moderation />} />
      <Route path="moderation/:taskId" element={<ModerationCase />} />
      <Route path="examops" element={<ExamOps />} />
      <Route path="examops/attempts/:attemptId" element={<ExamCase />} />
      <Route path="labs" element={<LabDesk />} />
      <Route path="operations" element={<Operations />} />
      <Route path="account" element={<Account />} />
      <Route path="*" element={<Navigate to="/staff" replace />} />
    </Route>
  );
}
