import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Notification } from '../api/types';
import { Link } from 'react-router-dom';
import { notificationLink, notificationText } from '../lib/format';
import { Card, Hold } from '../components/ui';

export default function Notifications() {
  const [items, setItems] = useState<Notification[] | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.get<Notification[]>('/v1/me/notifications').then(setItems).catch(setError); }, []);
  const read = async (n: Notification) => { try { await api.post(`/v1/me/notifications/${n.id}/read`); setItems((xs) => xs?.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) ?? null); } catch (e) { setError(e); } };
  if (error || !items) return <Hold title="Notifications" error={error} what="Loading notifications" />;
  return (
    <div><h1>Notifications</h1>
      {!items.length ? <Card><p>Nothing new.</p></Card> : <ul className="plain">{items.map((n) => (
        <li key={n.id}><Card><div className="row"><span className={n.readAt ? 'muted' : 'strong'}>{notificationText(n.type)}{notificationLink(n.type, n.payload) && <> <Link to={notificationLink(n.type, n.payload)!}>View</Link></>}</span>
          <span className="muted">{new Date(n.createdAt).toLocaleString()}</span>
          {!n.readAt && <button className="link" onClick={() => void read(n)}>Mark as read</button>}</div></Card></li>))}</ul>}
    </div>
  );
}
