import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../api/client';
import type { CreatedUser, UserRow } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { mayGrant, ROLE_INFO, userStatusLabel, validateNewUser, when } from '../lib/users';
import { canSee, hasAny, roleLabel, USERS } from '../lib/roles';

export default function Users() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'users')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <Directory myRoles={me!.roles} canWrite={hasAny(me?.roles, USERS.write)} />;
}

function Directory({ myRoles, canWrite }: { myRoles: string[]; canWrite: boolean }) {
  const [q, setQ] = useState(''); const [role, setRole] = useState(''); const [status, setStatus] = useState(''); const [applied, setApplied] = useState({ q: '', role: '', status: '' });
  const [rows, setRows] = useState<UserRow[] | null>(null); const [next, setNext] = useState<string | null>(null); const [error, setError] = useState<unknown>(null); const [more, setMore] = useState(false); const [created, setCreated] = useState<CreatedUser | null>(null);
  const url = useCallback((cursor?: string) => { const p = new URLSearchParams({ limit: '50' }); if (applied.q.trim()) p.set('q', applied.q.trim()); if (applied.role) p.set('role', applied.role); if (applied.status) p.set('status', applied.status); if (cursor) p.set('cursor', cursor); return `/v1/admin/users?${p}`; }, [applied]);
  const load = useCallback(async () => { try { const r = await api.page<UserRow>(url()); setRows(r.items); setNext(r.next); setError(null); } catch (e) { setError(e); } }, [url]);
  useEffect(() => { setRows(null); void load(); }, [load]);
  const loadMore = async () => { setMore(true); try { const r = await api.page<UserRow>(url(next!)); setRows((x) => [...(x ?? []), ...r.items]); setNext(r.next); } catch (e) { setError(e); } finally { setMore(false); } };
  return (
    <div>
      <h1>People</h1>
      <p className="muted">Everyone with an account. Changes here are recorded in the audit trail, with your reason.</p>
      <form className="choices" role="search" onSubmit={(e) => { e.preventDefault(); setApplied({ q, role, status }); }}>
        <label htmlFor="u-q" className="sr-only">Search by name or email</label><input id="u-q" type="search" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <label htmlFor="u-r">Role</label><select id="u-r" value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 'auto' }}><option value="">Any</option>{ROLE_INFO.map(([k]) => <option key={k} value={k}>{roleLabel(k)}</option>)}</select>
        <label htmlFor="u-s">Status</label><select id="u-s" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="">Any</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option><option value="ERASED">Erased</option></select>
        <button>Search</button>
      </form>
      {canWrite && <NewUser myRoles={myRoles} onCreated={(c) => { setCreated(c); void load(); }} />}
      {created && <Created c={created} onDone={() => setCreated(null)} />}
      <ErrorNote error={error} />
      {!rows ? (!error && <Loading what="Loading people" />) : !rows.length ? <Card><p>No one matches.</p></Card> : (
        <Card><table><thead><tr><th>Name</th><th>Roles</th><th>Status</th><th>Last signed in</th><th>Two-step</th></tr></thead><tbody>{rows.map((u) => (
          <tr key={u.id}><td><Link to={`/staff/users/${u.id}`}>{u.name}</Link><br /><span className="muted">{u.email ?? ''}</span></td><td>{u.roles.map(roleLabel).join(', ')}</td>
            <td><Badge tone={u.status === 'ACTIVE' ? 'ok' : 'warn'}>{userStatusLabel(u.status)}</Badge>{u.locked && <> <Badge tone="warn">Locked</Badge></>}</td><td>{when(u.lastLoginAt)}</td><td>{u.mfaEnabled ? 'On' : 'Off'}</td></tr>))}</tbody></table>
          {next && <p><button onClick={() => void loadMore()} disabled={more}>{more ? 'Loading…' : 'Show more'}</button></p>}</Card>)}
    </div>
  );
}

function NewUser({ myRoles, onCreated }: { myRoles: string[]; onCreated: (c: CreatedUser) => void }) {
  const [open, setOpen] = useState(false); const [f, setF] = useState({ email: '', name: '', language: 'en', roles: [] as string[], sso: false }); const [problem, setProblem] = useState<string | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const submit = async () => {
    const p = validateNewUser(f); setProblem(p); if (p) return; setBusy(true); setError(null);
    try { const c = await api.post<CreatedUser>('/v1/admin/users', { email: f.email.trim(), name: f.name.trim(), language: f.language, roles: f.roles, ssoOnly: f.sso }); onCreated(c); setOpen(false); setF({ email: '', name: '', language: 'en', roles: [], sso: false }); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  if (!open) return <p><button onClick={() => setOpen(true)}>Add a person</button></p>;
  return (
    <Card title="Add a person">
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        <label htmlFor="nu-n">Name</label><input id="nu-n" value={f.name} onChange={(e) => { setF({ ...f, name: e.target.value }); setProblem(null); }} />
        <label htmlFor="nu-e">Email</label><input id="nu-e" type="email" value={f.email} onChange={(e) => { setF({ ...f, email: e.target.value }); setProblem(null); }} />
        <label htmlFor="nu-l">Language</label><select id="nu-l" value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}><option value="en">English</option><option value="hi">Hindi</option></select>
        <fieldset><legend>Roles</legend>{ROLE_INFO.map(([k, d]) => { const ok = mayGrant(myRoles, k); return <label key={k} className="inline" style={{ display: 'block' }}><input type="checkbox" disabled={!ok} checked={f.roles.includes(k)} onChange={(e) => { setF({ ...f, roles: e.target.checked ? [...f.roles, k] : f.roles.filter((x) => x !== k) }); setProblem(null); }} /> <strong>{roleLabel(k)}</strong> <span className="muted">{d}{ok ? '' : ' (only a super admin can give this role)'}</span></label>; })}</fieldset>
        <label className="inline"><input type="checkbox" checked={f.sso} onChange={(e) => setF({ ...f, sso: e.target.checked })} /> They sign in only through single sign-on (no password is created)</label>
        {problem && <p role="alert" className="note error">{problem}</p>}<ErrorNote error={error} />
        <div className="choices"><button disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button><button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </Card>
  );
}

/** A one-time password is shown exactly once, here, and is never stored in the page's state after it is dismissed. */
export function Created({ c, onDone }: { c: CreatedUser; onDone: () => void }) {
  const [copied, setCopied] = useState(false); const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollIntoView?.({ block: 'nearest' }); }, []); // the form it came from has just closed, so bring this into view
  const copy = async () => { try { await navigator.clipboard.writeText(c.temporaryPassword!); setCopied(true); } catch { setCopied(false); } };
  return (
    <div ref={box}><Card title={`Account created for ${c.email}`}>
      {c.temporaryPassword ? <>
        <p role="status">Give them this one-time password through a safe channel (not email or chat that others can read). <strong>It will not be shown again.</strong> They should change it at once from their account page{c.roles.some((r) => r !== 'LEARNER') ? ', and will be asked to set up two-step verification at their first sign-in' : ''}.</p>
        <p><code className="secret" aria-label="One-time password">{c.temporaryPassword}</code> <button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button></p></> : <p>They have no password: they can sign in only through single sign-on.</p>}
      <p className="choices"><Link to={`/staff/users/${c.id}`}>Open their record</Link><button onClick={onDone}>{c.temporaryPassword ? 'I have passed it on' : 'Done'}</button></p>
    </Card></div>
  );
}
