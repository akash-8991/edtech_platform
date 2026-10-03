import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { onNativeNotificationTap } from './lib/push';
import { useAuth } from './auth';
import Account from './pages/Account';
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
import LabAttend from './pages/LabAttend';
import LabDetail from './pages/LabDetail';
import Labs from './pages/Labs';
import Login from './pages/Login';
import Notifications from './pages/Notifications';
import Privacy from './pages/Privacy';
import Topic from './pages/Topic';
import Tutor from './pages/Tutor';
import { Loading } from './components/ui';
import { NetworkBanner } from './components/NetworkBanner';
import Downloads from './pages/Downloads';
import OfflineLesson from './pages/OfflineLesson';
import SsoCallback from './pages/SsoCallback';
import { LANGS, useLocale, useT, type Lang } from './lib/i18n';
import { useOnline } from './lib/offline/network';
import { RouteAnnouncer } from './components/RouteAnnouncer';
import { isLearner } from './lib/roles';
import StaffRoutes from './staff/StaffRoutes';

function Shell() {
  const { me, loading, signOut } = useAuth(); const t = useT(); const online = useOnline(); const { lang, setLang } = useLocale(); const [menu, setMenu] = useState(false); const loc = useLocation();
  const navigate = useNavigate();
  useEffect(() => { setMenu(false); }, [loc.pathname]); // a tapped link closes the phone menu
  useEffect(() => onNativeNotificationTap((path) => navigate(path)), [navigate]); // native app: a tapped push opens its screen
  if (loading) return <Loading what={t('Starting')} />;
  if (!me) return <Navigate to={online ? '/login' : '/offline'} replace />; // offline with no session: the saved lessons are still reachable
  if (!isLearner(me.roles)) return <Navigate to="/staff" replace />; // staff use the console, not the learner portal
  return (
    <>
      <a className="skip" href="#main">{t('Skip to content')}</a>
      <header className="top">
        <Link to="/" className="brand">{t('Learning Portal')}</Link>
        <button type="button" className="menu-toggle" aria-expanded={menu} aria-controls="main-nav" onClick={() => setMenu((m) => !m)}>{menu ? t('Close menu') : t('Menu')}</button>
        <nav id="main-nav" aria-label={t('Main')} className={menu ? 'open' : undefined}><NavLink to="/" end>{t('Courses')}</NavLink><NavLink to="/labs">{t('Labs')}</NavLink><NavLink to="/grades">{t('Grades')}</NavLink><NavLink to="/exams">{t('Exams')}</NavLink><NavLink to="/tutor">{t('AI tutor')}</NavLink><NavLink to="/doubts">{t('Ask a teacher')}</NavLink><NavLink to="/downloads">{t('Downloads')}</NavLink><NavLink to="/notifications">{t('Notifications')}</NavLink>
          <NavLink to="/privacy">{t('Privacy')}</NavLink></nav>
        <span className="top-end"><label htmlFor="lang" className="sr-only">{t('Language')}</label><select id="lang" className="lang-select" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>{LANGS.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.native}</option>)}</select>
          <NavLink to="/account" className="who">{me.name}</NavLink><button className="link" onClick={() => void signOut()}>{t('Sign out')}</button></span>
      </header>
      <NetworkBanner signedIn />
      <main id="main" tabIndex={-1}><Outlet /></main>
    </>
  );
}

/** Saved lessons, reachable with no sign-in and no connection. */
function OfflineHome() {
  const t = useT(); const { loading } = useAuth(); const online = useOnline();
  if (loading) return <Loading what={t('Starting')} />;
  return (<><a className="skip" href="#main">{t('Skip to content')}</a><header className="top"><Link to="/" className="brand">{t('Learning Portal')}</Link>{online && <Link to="/login">{t('Sign in')}</Link>}</header><NetworkBanner signedIn={false} /><main id="main" tabIndex={-1}><Outlet /></main></>);
}

export default function App() {
  return (
    <>
    <RouteAnnouncer />
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/sso/callback" element={<SsoCallback />} />
      <Route element={<OfflineHome />}><Route path="/offline" element={<Downloads offlineMode />} /><Route path="/offline/:assetId" element={<OfflineLesson />} /></Route>
      <Route element={<Shell />}>
        <Route index element={<Courses />} />
        <Route path="courses/:entitlementId" element={<Course />} />
        <Route path="courses/:entitlementId/topics/:topicId" element={<Topic />} />
        <Route path="labs" element={<Labs />} />
        <Route path="labs/attend" element={<LabAttend />} />
        <Route path="labs/:activityId" element={<LabDetail />} />
        <Route path="grades" element={<Grades />} />
        <Route path="grades/:submissionId" element={<GradeDetail />} />
        <Route path="exams" element={<Exams />} />
        <Route path="exams/:examId/check-in/:sessionId" element={<CheckIn />} />
        <Route path="exam-attempts/:attemptId" element={<ExamRunner />} />
        <Route path="exam-results/:attemptId" element={<ExamResultPage />} />
        <Route path="completion" element={<CompletionPage />} />
        <Route path="downloads" element={<Downloads />} />
        <Route path="downloads/:assetId" element={<OfflineLesson />} />
        <Route path="tutor" element={<Tutor />} />
        <Route path="doubts" element={<Doubts />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="privacy" element={<Privacy />} />
        <Route path="account" element={<Account />} />
      </Route>
      {StaffRoutes()}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
