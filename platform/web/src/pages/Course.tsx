import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { cachedGet } from '../lib/offline/cache';
import type { Progress } from '../api/types';
import { Badge, Card, Progress as Bar, Hold, StaleNote } from '../components/ui';
import { describeState } from '../lib/grades';
import { useT } from '../lib/i18n';

export default function Course() {
  const t = useT(); const { entitlementId = '' } = useParams(); const [p, setP] = useState<Progress | null>(null); const [error, setError] = useState<unknown>(null); const [stale, setStale] = useState(false);
  useEffect(() => { cachedGet<Progress>(`/v1/me/entitlements/${entitlementId}/progress`).then((r) => { setP(r.data); setStale(r.stale); }).catch(setError); }, [entitlementId]);
  if (error || !p) return <Hold title={t('Your progress')} error={error} what={t('Loading your progress')} />;
  return (
    <div>
      <p><Link to="/">{t('All courses')}</Link></p>
      <h1>{t('Your progress')}</h1>
      <StaleNote show={stale} />
      <Bar value={p.percentComplete} label={t('Course progress')} /><p>{t('{n}% of required topics complete', { n: p.percentComplete })}</p>
      <ol className="topics">
        {p.topics.map((tp, i) => (
          <li key={tp.topicId}>
            <Card title={tp.unlocked ? <Link to={`/courses/${entitlementId}/topics/${tp.topicId}`}>{i + 1}. {tp.title}</Link> : <span>{i + 1}. {tp.title}</span>}
              actions={tp.complete ? <Badge tone="ok">{t('Complete')}</Badge> : tp.unlocked ? <Badge tone="warn">{t('In progress')}</Badge> : <Badge tone="muted">{t('Locked')}</Badge>}>
              {tp.unlocked ? (
                <ul className="steps" aria-label={t('Steps to complete this topic')}>
                  <li className={tp.videoDone ? 'done' : ''}>{tp.videoDone ? '✓' : '○'} {t('Watch the video')}</li>
                  <li className={tp.quizPassed ? 'done' : ''}>{tp.quizPassed ? '✓' : '○'} {t('Pass the quiz')}</li>
                  <li className={tp.assignmentSubmitted ? 'done' : ''}>{tp.assignmentSubmitted ? '✓' : '○'} {t('Submit the assignment')}{tp.assignmentState ? <span className="muted"> ({describeState(tp.assignmentState).label.toLowerCase()})</span> : null}</li>
                </ul>) : <p className="muted">{t('Finish the previous topic to unlock this one.')}</p>}
            </Card>
          </li>))}
      </ol>
    </div>
  );
}
