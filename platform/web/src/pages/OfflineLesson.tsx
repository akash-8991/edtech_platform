import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { VideoPlayer } from '../components/VideoPlayer';
import { Hold } from '../components/ui';
import { useAuth } from '../auth';
import { useT } from '../lib/i18n';
import { offlineLessons, offlineMessage, type OfflineLesson as Lesson } from '../lib/offline/lessons';
import type { Playback } from '../api/types';

/** Plays a saved lesson: decrypted in memory only, with its saved captions and transcript. What you watch is recorded and sent when you are online. */
export default function OfflineLesson() {
  const t = useT(); const { assetId = '' } = useParams(); const { me } = useAuth(); const [state, setState] = useState<{ lesson: Lesson; playback: Playback } | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let release = () => undefined as void; let gone = false; setState(null); setError(null);
    offlineLessons.open(assetId).then((r) => { if (gone) return r.release(); release = r.release; setState({ lesson: r.lesson, playback: r.playback }); }).catch((e) => { if (!gone) setError(offlineMessage(e)); });
    return () => { gone = true; release(); };
  }, [assetId]);
  if (error) return <div><p><Link to={me ? '/downloads' : '/offline'}>{t('My downloads')}</Link></p><h1>{t('Saved lesson')}</h1><p role="alert" className="note warn">{error}</p></div>;
  if (!state) return <Hold title={t('Saved lesson')} error={null} what={t('Unlocking the lesson')} />;
  return (
    <div>
      <p><Link to={me ? '/downloads' : '/offline'}>{t('My downloads')}</Link></p>
      <h1>{state.lesson.title}</h1>
      <VideoPlayer topicId={state.lesson.topicId} playback={state.playback} onProgress={() => undefined} />
      <p className="muted">{t('Playing from this device. Your watch time is saved and sent when you are back online.')}</p>
    </div>
  );
}
