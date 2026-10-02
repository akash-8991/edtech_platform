import { Link, NavLink, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../auth';
import { Loading } from '../components/ui';
import { AREAS, canSee, isStaff, roleLabel } from '../lib/roles';

export default function StaffShell() {
  const { me, loading, signOut } = useAuth();
  if (loading) return <Loading what="Starting" />;
  if (!me) return <Navigate to="/login" replace />;
  if (!isStaff(me.roles)) return <Navigate to="/" replace />;
  const roles = me.roles.filter((r) => r !== 'LEARNER');
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="top staff-top">
        <Link to="/staff" className="brand staff-brand">Staff console</Link>
        <nav aria-label="Staff">
          {(Object.keys(AREAS) as (keyof typeof AREAS)[]).filter((a) => canSee(me.roles, a)).map((a) => <NavLink key={a} to={`/staff/${a}`}>{AREAS[a].title}</NavLink>)}
        </nav>
        <NavLink to="/staff/account" className="who">{me.name}</NavLink><button className="link" onClick={() => void signOut()}>Sign out</button>
      </header>
      <main id="main" tabIndex={-1}>
        <p className="rolechips" aria-label="Your roles">{roles.map((r) => <span key={r} className="badge muted">{roleLabel(r)}</span>)}</p>
        <Outlet />
      </main>
    </>
  );
}
