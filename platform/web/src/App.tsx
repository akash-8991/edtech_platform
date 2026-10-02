import { Link, NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Course from './pages/Course';
import Courses from './pages/Courses';
import CheckIn from './pages/CheckIn';
import CompletionPage from './pages/Completion';
import Doubts from './pages/Doubts';
import ExamResultPage from './pages/ExamResult';
import ExamRunner from './pages/ExamRunner';
import Exams from './pages/Exams';
import GradeDetail from './pages/GradeDetail';
import Grades from './pages/Grades';
import Login from './pages/Login';
import Notifications from './pages/Notifications';
import Topic from './pages/Topic';
import Tutor from './pages/Tutor';
import { Loading } from './components/ui';

function Shell() {
  const { me, loading, signOut } = useAuth();
  if (loading) return <Loading what="Starting" />;
  if (!me) return <Navigate to="/login" replace />;
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <Link to="/" className="brand">Learning Portal</Link>
        <nav aria-label="Main"><NavLink to="/" end>Courses</NavLink><NavLink to="/grades">Grades</NavLink><NavLink to="/exams">Exams</NavLink><NavLink to="/tutor">AI tutor</NavLink><NavLink to="/doubts">Ask a teacher</NavLink><NavLink to="/notifications">Notifications</NavLink></nav>
        <span className="who">{me.name}</span><button className="link" onClick={() => void signOut()}>Sign out</button>
      </header>
      <main id="main" tabIndex={-1}><Outlet /></main>
    </>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Shell />}>
        <Route index element={<Courses />} />
        <Route path="courses/:entitlementId" element={<Course />} />
        <Route path="courses/:entitlementId/topics/:topicId" element={<Topic />} />
        <Route path="grades" element={<Grades />} />
        <Route path="grades/:submissionId" element={<GradeDetail />} />
        <Route path="exams" element={<Exams />} />
        <Route path="exams/:examId/check-in/:sessionId" element={<CheckIn />} />
        <Route path="exam-attempts/:attemptId" element={<ExamRunner />} />
        <Route path="exam-results/:attemptId" element={<ExamResultPage />} />
        <Route path="completion" element={<CompletionPage />} />
        <Route path="tutor" element={<Tutor />} />
        <Route path="doubts" element={<Doubts />} />
        <Route path="notifications" element={<Notifications />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
