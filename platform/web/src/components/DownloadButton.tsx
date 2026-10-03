import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { messageFor } from '../api/client';
import { fmtDate, useT } from '../lib/i18n';
import { OfflineError, offlineLessons, offlineMessage, type OfflineLesson } from '../lib/offline/lessons';
import { useOnline } from '../lib/offline/network';

const mb = (n: number) => `${Math.max(1, Math.round(n / 1_048_576))} MB`;

/** "Save for offline": downloads this lesson to this device. Shows progress, then when the saved copy expires. */
export function DownloadButton({ topicId, entitlementId, title, language, userId, assetId }: { topicId: string; entitlementId: string; title: string; language: string; userId: string; assetId?: string }) {
  const t = useT(); const online = useOnline(); const [lesson, setLesson] = useState<OfflineLesson | null>(null); const [progress, setProgress] = useState<number | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!assetId) return; offlineLessons.list(userId).then((all) => setLesson(all.find((l) => l.assetId === assetId) ?? null)).catch(() => undefined); }, [assetId, userId]);
  if (!offlineLessons.supported()) return null;
  const go = async () => {
    setError(null); setProgress(0);
    try { setLesson(await offlineLessons.download({ topicId, entitlementId, title, language, userId }, setProgress)); } catch (e) { setError(e instanceof OfflineError ? offlineMessage(e) : messageFor(e)); } finally { setProgress(null); }
  };
  const remove = async () => { if (lesson) { await offlineLessons.remove(lesson.assetId); setLesson(null); } };
  return (
    <div className="download">
      {lesson ? <p role="status">{t('Saved on this device ({size}). Expires {date}.', { size: mb(lesson.size), date: fmtDate(lesson.expiresAt) })} <Link to={`/downloads/${lesson.assetId}`}>{t('Watch offline')}</Link> · <button className="link" onClick={() => void remove()}>{t('Remove')}</button></p>
        : <button type="button" className="secondary" onClick={() => void go()} disabled={progress !== null || !online}>{progress !== null ? t('Downloading… {n}%', { n: Math.round(progress * 100) }) : t('Save for offline')}</button>}
      {progress !== null && <div className="bar" role="progressbar" aria-label={t('Download progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
      {!online && !lesson && <p className="muted">{t('Connect to the internet to save this lesson.')}</p>}
      {error && <p role="alert" className="note error">{error}</p>}
    </div>
  );
}
