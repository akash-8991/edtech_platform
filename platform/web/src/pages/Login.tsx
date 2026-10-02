import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { api, messageFor } from '../api/client';
import { useAuth } from '../auth';

export default function Login() {
  const { me, refreshMe } = useAuth();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  if (me) return <Navigate to="/" replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api.login(email.trim(), password);
      if (r.status === 'staff') { setError('This portal is for learners. Staff accounts sign in through the administration console.'); api.clear(); }
      else await refreshMe();
    } catch (err) { setError(messageFor(err)); } finally { setBusy(false); }
  };
  return (
    <main className="auth">
      <h1>Learning Portal</h1>
      <p className="muted">Sign in with the account your institute created for you.</p>
      <form onSubmit={submit} noValidate>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p role="alert" className="note error">{error}</p>}
        <button type="submit" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="muted">Locked out or forgot your password? Contact your programme support team. After 5 wrong attempts an account is paused for 15 minutes.</p>
    </main>
  );
}
