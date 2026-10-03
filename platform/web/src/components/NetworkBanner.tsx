import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { EventOutbox } from '../lib/heartbeat';
import { useT } from '../lib/i18n';
import { useOnline } from '../lib/offline/network';
import { offlineLessons } from '../lib/offline/lessons';

/** Says so when the device is offline, and the moment it is back sends what was recorded offline and drops downloads whose access has ended. */
export function NetworkBanner({ signedIn }: { signedIn: boolean }) {
  const t = useT(); const online = useOnline();
  useEffect(() => {
    if (!online || !signedIn) return;
    const outbox = new EventOutbox((events) => api.post<{ results: { eventId: string; status: string }[] }>('/v1/learning-events', { events }).then((r) => r.results));
    void outbox.flush(); void offlineLessons.sync().catch(() => undefined);
  }, [online, signedIn]);
  if (online) return null;
  return <p className="offline-bar" role="status">{t('You are offline. Saved lessons and screens still work; changes are sent when you are back online.')} <Link to={signedIn ? '/downloads' : '/offline'}>{t('My downloads')}</Link></p>;
}
