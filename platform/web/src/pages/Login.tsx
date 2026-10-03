import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api, messageFor } from '../api/client';
import { useAuth } from '../auth';
import { isLearner } from '../lib/roles';
import { LANGS, useLocale, useT } from '../lib/i18n';
import { offlineLessons } from '../lib/offline/lessons';

type Step = { kind: 'password' } | { kind: 'mfa'; token: string } | { kind: 'enroll'; token: string };

export default function Login() {
  const { me, refreshMe } = useAuth(); const t = useT(); const { lang, setLang } = useLocale();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  if (me) return <Navigate to={isLearner(me.roles) ? '/' : '/staff'} replace />;
  return (
    <main className="auth">
      <p className="lang-switch" role="group" aria-label={t('Language')}>{LANGS.map((l) => <button key={l.code} type="button" className="link" lang={l.code} aria-pressed={lang === l.code} onClick={() => setLang(l.code)}>{l.native}</button>)}</p>
      <h1>{t('Learning Portal')}</h1>
      {step.kind === 'password' && <PasswordStep onNext={setStep} onDone={refreshMe} />}
      {step.kind === 'mfa' && <MfaStep token={step.token} onDone={refreshMe} onBack={() => setStep({ kind: 'password' })} />}
      {step.kind === 'enroll' && <EnrollStep token={step.token} onDone={refreshMe} onBack={() => setStep({ kind: 'password' })} />}
    </main>
  );
}

function PasswordStep({ onNext, onDone }: { onNext: (s: Step) => void; onDone: () => Promise<void> }) {
  const t = useT(); const [sso, setSso] = useState<{ enabled: boolean; label?: string } | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.ssoConfig().then(setSso).catch(() => setSso(null)); offlineLessons.list().then((l) => setSaved(l.length > 0)).catch(() => undefined); }, []);
  const goSso = async () => { try { const r = await api.ssoStart(); window.location.assign(r.authorizationUrl); } catch (e) { setError(messageFor(e)); } };
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api.login(email.trim(), password);
      if (r.status === 'ok') await onDone(); else if (r.status === 'mfa') onNext({ kind: 'mfa', token: r.mfaToken }); else onNext({ kind: 'enroll', token: r.enrollmentToken });
    } catch (err) { setError(messageFor(err)); } finally { setBusy(false); }
  };
  return (<>
    {sso?.enabled && <><p><button type="button" onClick={() => void goSso()}>{t('Sign in with {name}', { name: sso.label ?? t('your institute account') })}</button></p><p className="muted" aria-hidden="true">{t('or use your email and password')}</p></>}
    <p className="muted">{t('Sign in with the account your institute created for you.')}</p>
    <form onSubmit={submit} noValidate>
      <label htmlFor="email">{t('Email')}</label><input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor="password">{t('Password')}</label><input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p role="alert" className="note error">{error}</p>}
      <button type="submit" disabled={busy || !email || !password}>{busy ? t('Signing in…') : t('Sign in')}</button>
    </form>
    {saved && <p><Link to="/offline">{t('Watch my saved lessons')}</Link></p>}
    <p className="muted">{t('Locked out or forgot your password? Contact your programme support team. After 5 wrong attempts an account is paused for 15 minutes.')}</p>
  </>);
}

/** Staff accounts must use an authenticator app (or a one-time backup code). */
function MfaStep({ token, onDone, onBack }: { token: string; onDone: () => Promise<void>; onBack: () => void }) {
  const [code, setCode] = useState(''); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(null); try { await api.verifyMfa(token, code); await onDone(); } catch (err) { setError(messageFor(err)); } finally { setBusy(false); } };
  return (
    <form onSubmit={submit} noValidate aria-label="Two-step verification">
      <h2>Two-step verification</h2><p className="muted">Enter the 6-digit code from your authenticator app, or one of your backup codes.</p>
      <label htmlFor="mfa-code">Code</label><input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
      {error && <p role="alert" className="note error">{error}</p>}
      <div className="choices"><button type="submit" disabled={busy || code.trim().length < 6}>{busy ? 'Checking…' : 'Verify'}</button><button type="button" className="secondary" onClick={onBack}>Back</button></div>
    </form>
  );
}

/** First sign-in of a staff member: set up the authenticator app, confirm with a code, and save the backup codes (shown once). */
function EnrollStep({ token, onDone, onBack }: { token: string; onDone: () => Promise<void>; onBack: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null); const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState(''); const [backup, setBackup] = useState<string[] | null>(null); const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const start = async () => { setBusy(true); setError(null); try { const s = await api.enrollStart(token); setSetup(s); try { const QR = await import('qrcode'); setQr(await QR.toDataURL(s.otpauthUri, { margin: 1, width: 192 })); } catch { /* the secret below is enough */ } } catch (e) { setError(messageFor(e)); } finally { setBusy(false); } };
  const confirm = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(null); try { const r = await api.enrollConfirm(token, code); setBackup(r.backupCodes); } catch (err) { setError(messageFor(err)); } finally { setBusy(false); } };
  if (backup) return (
    <div><h2>Save your backup codes</h2><p className="note warn" role="alert">These are shown <strong>only once</strong>. Each works one time if you lose your phone. Store them somewhere safe, such as a password manager.</p>
      <ul className="backup mono" aria-label="Backup codes">{backup.map((c) => <li key={c}>{c}</li>)}</ul>
      <label className="choice"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved these codes</label>
      <button disabled={!saved} onClick={() => void onDone()}>Continue</button></div>);
  return (
    <div><h2>Set up two-step verification</h2><p className="muted">Staff accounts need an authenticator app (such as Google Authenticator, Authy or 1Password) before first use.</p>
      {!setup ? (<><button onClick={() => void start()} disabled={busy}>{busy ? 'Preparing…' : 'Begin setup'}</button>{error && <p role="alert" className="note error">{error}</p>}<p><button className="link" onClick={onBack}>Back</button></p></>) : (
        <form onSubmit={confirm} aria-label="Confirm authenticator">
          <ol><li>{qr ? <>Scan this code with your authenticator app:<br /><img src={qr} alt="QR code for your authenticator app" width={192} height={192} /></> : 'Add this account to your authenticator app.'}</li>
            <li>Or enter this key by hand: <span className="mono strong" aria-label="Setup key">{setup.secret}</span></li><li>Type the 6-digit code the app shows:</li></ol>
          <label htmlFor="enr-code">Code</label><input id="enr-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
          {error && <p role="alert" className="note error">{error}</p>}<button type="submit" disabled={busy || code.trim().length < 6}>{busy ? 'Checking…' : 'Confirm and finish'}</button></form>)}
    </div>
  );
}
