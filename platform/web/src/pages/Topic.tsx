import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { cachedGet } from '../lib/offline/cache';
import { DownloadButton } from '../components/DownloadButton';
import { useAuth } from '../auth';
import { usePrefs } from '../prefs';
import { useOnline } from '../lib/offline/network';
import type { Playback, Progress, TopicDetail } from '../api/types';
import { Assignment } from '../components/Assignment';
import { Quiz } from '../components/Quiz';
import { Badge, Card, Loading, Hold, StaleNote } from '../components/ui';
import { describeState } from '../lib/grades';
import { VideoPlayer } from '../components/VideoPlayer';
import { useT } from '../lib/i18n';

export default function Topic() {
  const { entitlementId = '', topicId = '' } = useParams(); const t = useT(); const { me } = useAuth(); const { prefs } = usePrefs(); const online = useOnline(); const [stale, setStale] = useState(false);
  const [topic, setTopic] = useState<TopicDetail | null>(null); const [prog, setProg] = useState<Progress | null>(null);
  const [playback, setPlayback] = useState<Playback | null>(null); const [low, setLow] = useState(() => localStorage.getItem('edtech.low') === '1');
  const [error, setError] = useState<unknown>(null); const [grade, setGrade] = useState<{ id: string; state: string } | null>(null); const [keepQuiz, setKeepQuiz] = useState(false); // keep the result visible after the quiz is passed

  const reload = useCallback(async () => {
    try { const [tp, p] = await Promise.all([cachedGet<TopicDetail>(`/v1/topics/${topicId}`), cachedGet<Progress>(`/v1/me/entitlements/${entitlementId}/progress`)]); setTopic(tp.data); setProg(p.data); setStale(tp.stale || p.stale); setError(null); }
    catch (e) { setError(e); }
  }, [topicId, entitlementId]);
  useEffect(() => { void reload(); }, [reload]);
  const submittedNow = prog?.topics.find((x) => x.topicId === topicId)?.assignmentSubmitted;
  useEffect(() => { if (submittedNow) api.get<{ submissionId: string; state: string }[]>(`/v1/me/submissions?topicId=${topicId}`).then((r) => setGrade(r[0] ? { id: r[0].submissionId, state: r[0].state } : null)).catch(() => undefined); }, [submittedNow, topicId]);
  useEffect(() => { setPlayback(null); api.get<Playback>(`/v1/topics/${topicId}/playback?${low ? 'mode=low&' : ''}language=${prefs.language ?? 'en'}`).then(setPlayback).catch((e) => { if (!(e instanceof ApiError && e.status === 404)) setError(e); }); }, [topicId, low, prefs.language]);

  if (error instanceof ApiError && error.status === 403) return (<div><p><Link to={`/courses/${entitlementId}`}>{t('Back to the course')}</Link></p><p className="note warn" role="alert">{t('This topic is locked. Complete the previous topic first, or check that your access is active.')}</p></div>);
  if (error || !topic || !prog) return <Hold title={t('Topic')} error={error} what={t('Loading the topic')} />;
  const row = prog.topics.find((x) => x.topicId === topicId);
  const videoDone = row?.videoDone ?? false, quizPassed = row?.quizPassed ?? false, submitted = row?.assignmentSubmitted ?? false;

  return (
    <div>
      <p><Link to={`/courses/${entitlementId}`}>{t('Back to the course')}</Link></p>
      <h1>{topic.title}</h1>
      <StaleNote show={stale} />
      {row?.complete && <p className="note ok" role="status">{t('You have completed this topic.')}</p>}
      {topic.outcomes?.length ? <details><summary>{t('What you will learn')}</summary><ul>{topic.outcomes.map((o) => <li key={o}>{o}</li>)}</ul></details> : null}

      <Card title={t('1. Watch')} actions={<><Badge tone={videoDone ? 'ok' : 'warn'}>{videoDone ? t('Done') : t('To do')}</Badge>
        <label className="inline"><input type="checkbox" checked={low} onChange={(e) => { setLow(e.target.checked); localStorage.setItem('edtech.low', e.target.checked ? '1' : '0'); }} /> {t('Low-bandwidth mode')}</label></>}>
        {playback ? <><VideoPlayer key={playback.assetId + playback.mode} topicId={topicId} playback={playback} onProgress={reload} />{me && <DownloadButton topicId={topicId} entitlementId={entitlementId} title={topic.title} language={playback.language} userId={me.id} assetId={playback.assetId} />}</>
          : !online ? <p className="muted">{t('The video needs a connection. If you saved this lesson, open it from your downloads.')} <Link to="/downloads">{t('My downloads')}</Link></p> : <Loading what={t('Preparing the lesson')} />}
      </Card>

      <Card title={t('2. Quiz')} actions={<Badge tone={quizPassed ? 'ok' : videoDone ? 'warn' : 'muted'}>{quizPassed ? t('Passed') : videoDone ? t('Ready') : t('Locked')}</Badge>}>
        {quizPassed && !keepQuiz ? <p>{t('You passed this quiz.')}</p> : !videoDone ? <p className="muted">{t('Finish watching the video and answer its questions to unlock the quiz.')}</p>
          : topic.quiz ? <Quiz topicId={topicId} remaining={row?.quizAttemptsRemaining ?? null} onDone={() => { setKeepQuiz(true); void reload(); }} /> : <p>{t('This topic has no quiz.')}</p>}
      </Card>

      <Card title={t('3. Assignment')} actions={<Badge tone={submitted ? 'ok' : quizPassed ? 'warn' : 'muted'}>{submitted ? t('Submitted') : quizPassed ? t('Ready') : t('Locked')}</Badge>}>
        {!quizPassed && !submitted ? <p className="muted">{t('Pass the quiz to unlock the assignment.')}</p>
          : topic.assignment ? <><Assignment topicId={topicId} instructions={topic.assignment.instructions} submitted={submitted} onDone={reload} />{grade && <p><Link to={`/grades/${grade.id}`}>{t('View your grade and feedback')}</Link> <Badge tone={describeState(grade.state).tone}>{describeState(grade.state).label}</Badge></p>}</> : <p>{t('This topic has no assignment.')}</p>}
      </Card>
    </div>
  );
}
