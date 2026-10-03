import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { useAuth } from '../auth';
import { fmtDate, fmtDateTime, useT } from '../lib/i18n';
import { offlineLessons, type OfflineLesson } from '../lib/offline/lessons';
import { idbGet } from '../lib/offline/idb';
import { useOnline } from '../lib/offline/network';

const mb = (n: number) => `${Math.max(1, Math.round(n / 1_048_576))} MB`;
const minutes = (s: number) => Math.max(1, Math.round(s / 60));

/** Lessons saved on this device. Works with no sign-in and no connection (then it shows the last person who used this device). */
export default function Downloads({ offlineMode = false }: { offlineMode?: boolean }) {
  const t = useT(); const { me } = useAuth(); const online = useOnline(); const [userId, setUserId] = useState<string | null>(me?.id ?? null); const [name, setName] = useState<string | null>(me?.name ?? null);
  const [items, setItems] = useState<OfflineLesson[] | null>(null); const [usage, setUsage] = useState<{ used: number; free?: number } | null>(null); const [error, setError] = useState<unknown>(null); const [notice, setNotice] = useState('');
  useEffect(() => { if (me) { setUserId(me.id); setName(me.name); } else idbGet<{ id: string; name: string }>('kv', 'lastUser').then((u) => { if (u) { setUserId(u.id); setName(u.name); } else setUserId(''); }).catch(() => setUserId('')); }, [me]);
  const load = useCallback(async () => { if (userId === null) return; try { setItems(await offlineLessons.list(userId || undefined)); setUsage(await offlineLessons.usage()); } catch (e) { setError(e); setItems([]); } }, [userId]);
  useEffect(() => { void load(); }, [load]);
  const remove = async (l: OfflineLesson) => { await offlineLessons.remove(l.assetId); setNotice(t('Removed “{title}” from this device.', { title: l.title })); await load(); };
  const removeAll = async () => { await offlineLessons.removeAll(); setNotice(t('Everything was removed from this device.')); await load(); };
  const check = async () => { setError(null); try { const gone = await offlineLessons.sync(userId || undefined); setNotice(gone.length ? t('{n} lesson(s) were removed because your access to them has ended.', { n: gone.length }) : t('Everything saved here is still valid.')); await load(); } catch (e) { setError(e); } };
  return (
    <div>
      {offlineMode && !me && <p><Link to="/login">{t('Sign in')}</Link></p>}
      <h1>{t('My downloads')}</h1>
      <p className="muted">{t('Lessons you saved to watch without a connection. They are encrypted and only play on this device, and they stop working when your access ends or the saved copy expires.')}{name && !me ? ` ${t('Showing downloads for {name}.', { name })}` : ''}</p>
      {notice && <p className="note ok" role="status">{notice}</p>}<ErrorNote error={error} />
      {!offlineLessons.supported() ? <Card><p>{t('This browser cannot keep lessons offline.')}</p></Card> : !items ? <Loading /> : !items.length ? <Card><p>{t('Nothing is saved on this device yet. Open a lesson and choose “Save for offline”.')}</p></Card> : (<>
        <ul className="plain">{items.map((l) => { const expired = Date.parse(l.expiresAt) <= Date.now(); return (
          <li key={l.assetId}><Card title={expired ? l.title : <Link to={`/downloads/${l.assetId}`}>{l.title}</Link>} actions={expired ? <Badge tone="warn">{t('Expired')}</Badge> : <Badge tone="ok">{t('Ready')}</Badge>}>
            <p className="muted">{t('{min} min · {size} · saved {date}', { min: minutes(l.durationSec), size: mb(l.size), date: fmtDate(l.downloadedAt) })} · {t('expires {when}', { when: fmtDateTime(l.expiresAt) })}</p>
            <div className="choices">{!expired && <Link className="button" to={`/downloads/${l.assetId}`}>{t('Watch offline')}</Link>}<button className="secondary" onClick={() => void remove(l)}>{t('Remove')}</button></div></Card></li>); })}</ul>
        <Card title={t('Storage')}><p>{t('{size} used by downloads.', { size: mb(usage?.used ?? 0) })}{usage?.free !== undefined ? ` ${t('About {size} free on this device.', { size: mb(usage.free) })}` : ''}</p>
          <div className="choices">{online && !offlineMode && <button className="secondary" onClick={() => void check()}>{t('Check my access now')}</button>}<button className="secondary" onClick={() => void removeAll()}>{t('Remove all downloads')}</button></div></Card></>)}
    </div>
  );
}
