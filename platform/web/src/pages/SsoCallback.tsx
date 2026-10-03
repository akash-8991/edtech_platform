import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { api, messageFor } from '../api/client';
import { useAuth } from '../auth';
import { Loading } from '../components/ui';
import { useT } from '../lib/i18n';
import { isLearner } from '../lib/roles';

/** Where the identity provider sends the browser back. The one-time code is exchanged by our server, which checks the token and the account. */
export default function SsoCallback() {
  const t = useT(); const [q] = useSearchParams(); const { me, refreshMe } = useAuth(); const [error, setError] = useState<string | null>(null); const started = useRef(false);
  const code = q.get('code') ?? '', state = q.get('state') ?? '', denied = q.get('error');
  useEffect(() => {
    if (started.current || denied || !code || !state) return; started.current = true; // the code works once: never send it twice (React may run effects twice in development)
    api.ssoFinish(code, state).then(() => refreshMe()).catch((e) => setError(messageFor(e)));
  }, [code, state, denied, refreshMe]);
  if (me) return <Navigate to={isLearner(me.roles) ? '/' : '/staff'} replace />;
  const problem = denied ? t('Single sign-on was cancelled or refused by your identity provider.') : !code || !state ? t('This sign-in link is incomplete. Start again from the sign-in page.') : error;
  return (
    <main className="auth"><h1>{t('Signing you in')}</h1>
      {problem ? <><p role="alert" className="note error">{problem}</p><p><Link to="/login">{t('Back to sign in')}</Link></p></> : <Loading what={t('Checking with your identity provider')} />}</main>
  );
}
