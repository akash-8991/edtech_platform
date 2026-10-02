import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { SessionInfo } from '../api/types';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { useAuth } from '../auth';
import { friendlyDevice } from '../lib/privacy';

export default function Account() {
  const { me } = useAuth(); const [sessions, setSessions] = useState<SessionInfo[] | null>(null); const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api.get<SessionInfo[]>('/v1/me/sessions').then(setSessions).catch(setError), []);
  useEffect(() => { void load(); }, [load]);
  const revoke = async (s: SessionInfo) => { setError(null); try { await api.request('DELETE', `/v1/me/sessions/${s.id}`); await load(); } catch (e) { setError(e); } };
  return (
    <div>
      <h1>Account and security</h1>
      {me && <p className="muted">Signed in as {me.name} ({me.email}).</p>}
      <PasswordCard />
      <Card title="Where you are signed in">
        <ErrorNote error={error} />
        {!sessions ? <Loading /> : (
          <ul className="plain">{sessions.map((s) => (
            <li key={s.id} className="dim"><div className="row"><span className="strong">{friendlyDevice(s.device)}</span>{s.current ? <Badge tone="ok">This device</Badge> : <button className="link" onClick={() => void revoke(s)}>Sign out this device</button>}</div>
              <p className="muted">Signed in {new Date(s.createdAt).toLocaleString()}{s.lastSeenAt ? ` · last active ${new Date(s.lastSeenAt).toLocaleString()}` : ''}</p></li>))}</ul>)}
        <p className="muted">If you do not recognise a device, sign it out and change your password.</p>
      </Card>
    </div>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState(''); const [next, setNext] = useState(''); const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false); const [done, setDone] = useState<number | null>(null); const [error, setError] = useState<unknown>(null);
  const issues: string[] = error instanceof ApiError && error.code === 'weak_password' && Array.isArray(error.body?.issues) ? error.body.issues : [];
  const mismatch = !!again && next !== again;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null); setDone(null);
    try { const r = await api.post<{ otherSessionsRevoked?: number }>('/v1/auth/password', { current, next }); setDone(r.otherSessionsRevoked ?? 0); setCurrent(''); setNext(''); setAgain(''); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Card title="Change your password">
      <form onSubmit={submit}>
        <label htmlFor="pw-cur">Current password</label><input id="pw-cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <label htmlFor="pw-new">New password</label><input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="pw-help" />
        <p id="pw-help" className="muted">At least 12 characters, not a common password, not containing your email name, mixing letters with digits or symbols.</p>
        <label htmlFor="pw-again">Repeat the new password</label><input id="pw-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        {mismatch && <p role="alert" className="note error">The two passwords do not match.</p>}
        {issues.length > 0 ? <div role="alert" className="note error"><p>That password is not strong enough:</p><ul>{issues.map((i) => <li key={i}>{i}</li>)}</ul></div> : <ErrorNote error={error} />}
        {done !== null && <p role="status" className="note ok">Password changed.{done > 0 ? ` ${done} other device${done > 1 ? 's were' : ' was'} signed out.` : ''}</p>}
        <button type="submit" disabled={busy || !current || !next || next !== again}>{busy ? 'Saving…' : 'Change password'}</button>
      </form>
    </Card>
  );
}
