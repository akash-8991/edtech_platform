import { Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { Loading } from '../components/ui';
import { AREAS, canSee, isStaff, roleLabel } from '../lib/roles';

export default function StaffShell() {
  const { me, loading, signOut } = useAuth(); const [menu, setMenu] = useState(false); const loc = useLocation();
  useEffect(() => { setMenu(false); }, [loc.pathname]); // a tapped link closes the phone menu
  if (loading) return <Loading what="Starting" />;
  if (!me) return <Navigate to="/login" replace />;
  if (!isStaff(me.roles)) return <Navigate to="/" replace />;
  const roles = me.roles.filter((r) => r !== 'LEARNER');
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="top staff-top">
        <Link to="/staff" className="brand staff-brand">Staff console</Link>
        <button type="button" className="menu-toggle" aria-expanded={menu} aria-controls="staff-nav" onClick={() => setMenu((m) => !m)}>{menu ? 'Close menu' : 'Menu'}</button>
        <nav id="staff-nav" aria-label="Staff" className={menu ? 'open' : undefined}>
          {(Object.keys(AREAS) as (keyof typeof AREAS)[]).filter((a) => canSee(me.roles, a)).map((a) => <NavLink key={a} to={`/staff/${a}`}>{AREAS[a].title}</NavLink>)}
        </nav>
        <NavLink to="/staff/account" className="who">{me.name}</NavLink><button className="link" onClick={() => void signOut()}>Sign out</button>
      </header>
      <main id="main" tabIndex={-1} className="wide">
        <p className="rolechips" aria-label="Your roles">{roles.map((r) => <span key={r} className="badge muted">{roleLabel(r)}</span>)}</p>
        <Suspense fallback={<Loading />}><Outlet /></Suspense>
      </main>
    </>
  );
}
