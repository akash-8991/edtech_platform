import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Notification } from '../api/types';
import { Link } from 'react-router-dom';
import { notificationLink, notificationText } from '../lib/format';
import { Card, Hold } from '../components/ui';
import { fmtDateTime, useT } from '../lib/i18n';

export default function Notifications() {
  const t = useT(); const [items, setItems] = useState<Notification[] | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.get<Notification[]>('/v1/me/notifications').then(setItems).catch(setError); }, []);
  const read = async (n: Notification) => { try { await api.post(`/v1/me/notifications/${n.id}/read`); setItems((xs) => xs?.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) ?? null); } catch (e) { setError(e); } };
  if (error || !items) return <Hold title={t('Notifications')} error={error} what={t('Loading notifications')} />;
  return (
    <div><h1>{t('Notifications')}</h1>
      {!items.length ? <Card><p>{t('Nothing new.')}</p></Card> : <ul className="plain">{items.map((n) => (
        <li key={n.id}><Card><div className="row"><span className={n.readAt ? 'muted' : 'strong'}>{notificationText(n.type)}{notificationLink(n.type, n.payload) && <> <Link to={notificationLink(n.type, n.payload)!}>{t('View')}</Link></>}</span>
          <span className="muted">{fmtDateTime(n.createdAt)}</span>
          {!n.readAt && <button className="link" onClick={() => void read(n)}>{t('Mark as read')}</button>}</div></Card></li>))}</ul>}
    </div>
  );
}
