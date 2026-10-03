import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { SessionInfo } from '../api/types';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { useAuth } from '../auth';
import { friendlyDevice } from '../lib/privacy';
import { fmtDateTime, useT } from '../lib/i18n';

export default function Account() {
  const { me } = useAuth(); const t = useT(); const [sessions, setSessions] = useState<SessionInfo[] | null>(null); const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api.get<SessionInfo[]>('/v1/me/sessions').then(setSessions).catch(setError), []);
  useEffect(() => { void load(); }, [load]);
  const revoke = async (s: SessionInfo) => { setError(null); try { await api.request('DELETE', `/v1/me/sessions/${s.id}`); await load(); } catch (e) { setError(e); } };
  return (
    <div>
      <h1>{t('Account and security')}</h1>
      {me && <p className="muted">{t('Signed in as {name} ({email}).', { name: me.name, email: me.email })}</p>}
      <PasswordCard />
      <Card title={t('Where you are signed in')}>
        <ErrorNote error={error} />
        {!sessions ? <Loading /> : (
          <ul className="plain">{sessions.map((s) => (
            <li key={s.id} className="dim"><div className="row"><span className="strong">{friendlyDevice(s.device)}</span>{s.current ? <Badge tone="ok">{t('This device')}</Badge> : <button className="link" onClick={() => void revoke(s)}>{t('Sign out this device')}</button>}</div>
              <p className="muted">{t('Signed in {when}', { when: fmtDateTime(s.createdAt) })}{s.lastSeenAt ? ` · ${t('last active {when}', { when: fmtDateTime(s.lastSeenAt) })}` : ''}</p></li>))}</ul>)}
        <p className="muted">{t('If you do not recognise a device, sign it out and change your password.')}</p>
      </Card>
    </div>
  );
}

function PasswordCard() {
  const t = useT();
  const [current, setCurrent] = useState(''); const [next, setNext] = useState(''); const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false); const [done, setDone] = useState<number | null>(null); const [error, setError] = useState<unknown>(null);
  const issues: string[] = error instanceof ApiError && error.code === 'weak_password' && Array.isArray(error.body?.issues) ? error.body.issues : [];
  const mismatch = !!again && next !== again;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null); setDone(null);
    try { const r = await api.post<{ otherSessionsRevoked?: number }>('/v1/auth/password', { current, next }); setDone(r.otherSessionsRevoked ?? 0); setCurrent(''); setNext(''); setAgain(''); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Card title={t('Change your password')}>
      <form onSubmit={submit}>
        <label htmlFor="pw-cur">{t('Current password')}</label><input id="pw-cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <label htmlFor="pw-new">{t('New password')}</label><input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="pw-help" />
        <p id="pw-help" className="muted">{t('At least 12 characters, not a common password, not containing your email name, mixing letters with digits or symbols.')}</p>
        <label htmlFor="pw-again">{t('Repeat the new password')}</label><input id="pw-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        {mismatch && <p role="alert" className="note error">{t('The two passwords do not match.')}</p>}
        {issues.length > 0 ? <div role="alert" className="note error"><p>{t('That password is not strong enough:')}</p><ul>{issues.map((i) => <li key={i}>{i}</li>)}</ul></div> : <ErrorNote error={error} />}
        {done !== null && <p role="status" className="note ok">{t('Password changed.')}{done > 0 ? ` ${done > 1 ? t('{n} other devices were signed out.', { n: done }) : t('1 other device was signed out.')}` : ''}</p>}
        <button type="submit" disabled={busy || !current || !next || next !== again}>{busy ? t('Saving…') : t('Change password')}</button>
      </form>
    </Card>
  );
}
