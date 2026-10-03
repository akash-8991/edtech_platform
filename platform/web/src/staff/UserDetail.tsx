import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { UserDetailData } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { actionLabel, changeProblem, mayGrant, mayManage, ROLE_INFO, roleChange, userStatusLabel, when } from '../lib/users';
import { canSee, hasAny, PRIVACY, roleLabel, USERS } from '../lib/roles';

export default function UserDetail() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'users')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <Page myRoles={me!.roles} meId={me!.id} />;
}

function Page({ myRoles, meId }: { myRoles: string[]; meId: string }) {
  const { userId = '' } = useParams(); const [u, setU] = useState<UserDetailData | null>(null); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState<string | null>(null); const [secret, setSecret] = useState<string | null>(null);
  const load = useCallback(async (clear = true) => { try { setU(await api.get<UserDetailData>(`/v1/admin/users/${userId}`)); if (clear) setError(null); } catch (e) { setError(e); } }, [userId]);
  useEffect(() => { setU(null); setDone(null); setSecret(null); void load(); }, [load]);
  /** Runs an action, then refreshes but keeps the error on screen (a refusal's reason is what the person needs to read). */
  const act = async <T,>(fn: () => Promise<T>, ok: string): Promise<T | null> => { setError(null); setDone(null); try { const r = await fn(); setDone(ok); await load(false); return r; } catch (e) { setError(e); await load(false); return null; } };
  const note = useRef<HTMLDivElement>(null);
  useEffect(() => { if (done || secret || error) note.current?.scrollIntoView?.({ block: 'nearest' }); }, [done, secret, error]); // the result of an action may be out of sight above the button
  if (!u) return <div><p><Link to="/staff/users">Back to people</Link></p><ErrorNote error={error} />{!error && <Loading what="Loading the record" />}</div>;
  const self = u.id === meId; const canWrite = hasAny(myRoles, USERS.write) && !self && mayManage(myRoles, u.roles) && u.status !== 'ERASED';
  const reasonPost = (path: string, reason: string) => api.post(`/v1/admin/users/${u.id}/${path}`, { reason });
  return (
    <div>
      <p><Link to="/staff/users">Back to people</Link></p>
      <h1>{u.name}</h1>
      <p><Badge tone={u.status === 'ACTIVE' ? 'ok' : 'warn'}>{userStatusLabel(u.status)}</Badge> {u.locked && <Badge tone="warn">Locked after failed sign-ins</Badge>} {u.legalHold && <Badge tone="warn">Legal hold</Badge>} <span className="muted">{u.email} · {u.language === 'hi' ? 'Hindi' : 'English'} · last signed in {when(u.lastLoginAt)} · two-step {u.mfaEnabled ? 'on' : 'off'} · {u.activeSessions} active sign-in{u.activeSessions === 1 ? '' : 's'}</span></p>
      {self && <p className="note">This is you. You cannot change your own roles or status; ask another administrator.</p>}
      {!self && !mayManage(myRoles, u.roles) && hasAny(myRoles, USERS.write) && <p className="note">This person holds an administrator role, so only a super admin can change them.</p>}
      <div ref={note}><ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}</div>
      {secret && <Card title="One-time password"><p role="status">Give this to them through a safe channel. <strong>It will not be shown again.</strong> All their devices were signed out.</p><p><code className="secret" aria-label="One-time password">{secret}</code></p><button onClick={() => setSecret(null)}>I have passed it on</button></Card>}
      <Roles u={u} myRoles={myRoles} canWrite={canWrite} onSave={(add, remove, reason) => act(() => api.post(`/v1/admin/users/${u.id}/roles`, { add, remove, reason }), 'Roles saved. They have been signed out so the change takes effect.')} />
      {canWrite && <Account u={u} onStatus={(s, r) => act(() => api.post(`/v1/admin/users/${u.id}/status`, { status: s, reason: r }), s === 'SUSPENDED' ? 'Suspended and signed out everywhere.' : 'Reactivated.')} onUnlock={() => act(() => api.post(`/v1/admin/users/${u.id}/unlock`, {}), 'Unlocked.')} onReset={async (r) => { const x = await act(() => api.post<{ temporaryPassword: string }>(`/v1/admin/users/${u.id}/reset-password`, { reason: r }), 'Password reset.'); if (x) setSecret(x.temporaryPassword); return !!x; }} />}
      {!self && hasAny(myRoles, USERS.mfaReset) && u.status !== 'ERASED' && mayManage(myRoles, u.roles) && <Danger title="Reset two-step verification" help="Use when they have lost their authenticator and backup codes. They set it up again at their next sign-in, and every device is signed out." button="Reset two-step verification" onGo={(r) => act(() => reasonPost('mfa-reset', r), 'Two-step verification reset.')} disabled={!u.mfaEnabled && 'Two-step verification is not set up for this person.'} />}
      {!self && hasAny(myRoles, USERS.signOut) && u.status !== 'ERASED' && <Danger title="Sign out everywhere" help="Ends every sign-in on every device. They can sign in again unless the account is suspended." button="Sign out everywhere" onGo={(r) => act(() => reasonPost('revoke-sessions', r), 'Signed out everywhere.')} disabled={u.activeSessions === 0 && 'They have no active sign-ins.'} />}
      {hasAny(myRoles, PRIVACY.decide) && u.status !== 'ERASED' && <Danger title={u.legalHold ? 'Legal hold is on' : 'Legal hold'} help={u.legalHold ? 'While it is on, an erasure request for this person cannot be carried out. Lift it when the matter is closed.' : 'Stops this person\'s data from being erased (for example during a disciplinary or legal matter). Use only on a real instruction, and record it in the reason.'} button={u.legalHold ? 'Lift the legal hold' : 'Place a legal hold'} onGo={(r) => act(() => api.put(`/v1/privacy/users/${u.id}/legal-hold`, { hold: !u.legalHold, reason: r }), u.legalHold ? 'Legal hold lifted.' : 'Legal hold placed.')} />}
      {u.roles.includes('DOUBT_TEACHER') && !u.teacherProfile && <p className="note">They hold the Doubt Teacher role but are not registered at the doubt desk yet: an administrator does that under Doubt desk → Teachers.</p>}
      <Card title="History"><p className="muted">The last 25 things done to this account.</p>{!u.history.length ? <p>Nothing recorded.</p> : <table><thead><tr><th>When</th><th>What</th><th>By</th><th>Reason</th></tr></thead><tbody>{u.history.map((h) => <tr key={h.seq}><td>{when(h.at)}</td><td>{actionLabel(h.action)}</td><td>{h.by}</td><td>{h.reason ?? ''}</td></tr>)}</tbody></table>}</Card>
    </div>
  );
}

function Roles({ u, myRoles, canWrite, onSave }: { u: UserDetailData; myRoles: string[]; canWrite: boolean; onSave: (add: string[], remove: string[], reason: string) => Promise<unknown> }) {
  const [sel, setSel] = useState(u.roles); const [reason, setReason] = useState(''); const [problem, setProblem] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { setSel(u.roles); }, [u.roles.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const { add, remove } = roleChange(u.roles, sel);
  return (
    <Card title="Roles">
      <form onSubmit={(e) => { e.preventDefault(); const p = changeProblem(u.roles, sel, reason); setProblem(p); if (p) return; setBusy(true); void onSave(add, remove, reason.trim()).then((ok) => { setBusy(false); if (ok) setReason(''); }); }} noValidate>
        {ROLE_INFO.map(([k, d]) => { const ok = canWrite && mayGrant(myRoles, k); return <label key={k} className="inline" style={{ display: 'block' }}><input type="checkbox" disabled={!ok} checked={sel.includes(k)} onChange={(e) => { setSel(e.target.checked ? [...sel, k] : sel.filter((x) => x !== k)); setProblem(null); }} /> <strong>{roleLabel(k)}</strong> <span className="muted">{d}{canWrite && !mayGrant(myRoles, k) ? ' (only a super admin can change this)' : ''}</span></label>; })}
        {u.scopedRoles.length > 0 && <p className="muted">Also holds roles limited to a programme or cohort: {u.scopedRoles.map((r) => `${roleLabel(r.role)} (${r.programmeId ?? r.cohort})`).join(', ')}. Those are not changed here.</p>}
        {canWrite && <>
          <label htmlFor="ur-why">Reason for the change (recorded in the audit trail)</label><textarea id="ur-why" value={reason} onChange={(e) => { setReason(e.target.value); setProblem(null); }} aria-invalid={!!problem} />
          {problem && <p role="alert" className="note error">{problem}</p>}
          <p className="muted">Saving signs them out of every device so the new roles apply at once{add.some((r) => r !== 'LEARNER') ? ', and they will be asked to set up two-step verification' : ''}.</p>
          <button disabled={busy}>{busy ? 'Saving…' : 'Save roles'}</button></>}
      </form>
    </Card>
  );
}

function Account({ u, onStatus, onUnlock, onReset }: { u: UserDetailData; onStatus: (s: string, r: string) => Promise<unknown>; onUnlock: () => Promise<unknown>; onReset: (r: string) => Promise<boolean> }) {
  const suspended = u.status === 'SUSPENDED';
  return (
    <>
      <Danger title={suspended ? 'Reactivate this account' : 'Suspend this account'} help={suspended ? 'They will be able to sign in again.' : 'They are signed out everywhere at once and cannot sign in until reactivated. Their records are kept.'} button={suspended ? 'Reactivate' : 'Suspend'} onGo={(r) => onStatus(suspended ? 'ACTIVE' : 'SUSPENDED', r)} />
      {u.locked && <Card title="Locked"><p>Too many wrong passwords locked this account for a while.</p><button onClick={() => void onUnlock()}>Unlock now</button></Card>}
      <Danger title="Reset password" help="Creates a one-time password, shown to you once, and signs them out everywhere. Use when they cannot get in." button="Reset password" onGo={onReset} />
    </>
  );
}

/** One protected action: needs a written reason, which goes into the audit trail. */
function Danger({ title, help, button, onGo, disabled }: { title: string; help: string; button: string; onGo: (reason: string) => Promise<unknown>; disabled?: string | false }) {
  const [open, setOpen] = useState(false); const [r, setR] = useState(''); const [problem, setProblem] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  return (
    <Card title={title}>
      <p className="muted">{help}</p>
      {disabled ? <p className="muted">{disabled}</p> : !open ? <button onClick={() => setOpen(true)}>{button}…</button> : (
        <form onSubmit={(e) => { e.preventDefault(); if (!r.trim()) { setProblem('Write the reason: it is recorded in the audit trail.'); return; } setBusy(true); void onGo(r.trim()).then((ok) => { setBusy(false); if (ok) { setOpen(false); setR(''); } }); }} noValidate>
          <label htmlFor={`dz-${title}`}>Reason</label><textarea id={`dz-${title}`} value={r} onChange={(e) => { setR(e.target.value); setProblem(null); }} aria-invalid={!!problem} />{problem && <p role="alert" className="note error">{problem}</p>}
          <div className="choices"><button disabled={busy}>{busy ? 'Working…' : button}</button><button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></div>
        </form>)}
    </Card>
  );
}
