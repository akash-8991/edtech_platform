import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Playback, Progress, TopicDetail } from '../api/types';
import { Assignment } from '../components/Assignment';
import { Quiz } from '../components/Quiz';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { describeState } from '../lib/grades';
import { VideoPlayer } from '../components/VideoPlayer';

export default function Topic() {
  const { entitlementId = '', topicId = '' } = useParams();
  const [topic, setTopic] = useState<TopicDetail | null>(null); const [prog, setProg] = useState<Progress | null>(null);
  const [playback, setPlayback] = useState<Playback | null>(null); const [low, setLow] = useState(() => localStorage.getItem('edtech.low') === '1');
  const [error, setError] = useState<unknown>(null); const [grade, setGrade] = useState<{ id: string; state: string } | null>(null); const [keepQuiz, setKeepQuiz] = useState(false); // keep the result visible after the quiz is passed

  const reload = useCallback(async () => {
    try { const [t, p] = await Promise.all([api.get<TopicDetail>(`/v1/topics/${topicId}`), api.get<Progress>(`/v1/me/entitlements/${entitlementId}/progress`)]); setTopic(t); setProg(p); setError(null); }
    catch (e) { setError(e); }
  }, [topicId, entitlementId]);
  useEffect(() => { void reload(); }, [reload]);
  const submittedNow = prog?.topics.find((t) => t.topicId === topicId)?.assignmentSubmitted;
  useEffect(() => { if (submittedNow) api.get<{ submissionId: string; state: string }[]>(`/v1/me/submissions?topicId=${topicId}`).then((r) => setGrade(r[0] ? { id: r[0].submissionId, state: r[0].state } : null)).catch(() => undefined); }, [submittedNow, topicId]);
  useEffect(() => { setPlayback(null); api.get<Playback>(`/v1/topics/${topicId}/playback${low ? '?mode=low' : ''}`).then(setPlayback).catch((e) => { if (!(e instanceof ApiError && e.status === 404)) setError(e); }); }, [topicId, low]);

  if (error instanceof ApiError && error.status === 403) return (<div><p><Link to={`/courses/${entitlementId}`}>Back to the course</Link></p><p className="note warn" role="alert">This topic is locked. Complete the previous topic first, or check that your access is active.</p></div>);
  if (error) return <ErrorNote error={error} />;
  if (!topic || !prog) return <Loading what="Loading the topic" />;
  const row = prog.topics.find((t) => t.topicId === topicId);
  const videoDone = row?.videoDone ?? false, quizPassed = row?.quizPassed ?? false, submitted = row?.assignmentSubmitted ?? false;

  return (
    <div>
      <p><Link to={`/courses/${entitlementId}`}>Back to the course</Link></p>
      <h1>{topic.title}</h1>
      {row?.complete && <p className="note ok" role="status">You have completed this topic.</p>}
      {topic.outcomes?.length ? <details><summary>What you will learn</summary><ul>{topic.outcomes.map((o) => <li key={o}>{o}</li>)}</ul></details> : null}

      <Card title="1. Watch" actions={<><Badge tone={videoDone ? 'ok' : 'warn'}>{videoDone ? 'Done' : 'To do'}</Badge>
        <label className="inline"><input type="checkbox" checked={low} onChange={(e) => { setLow(e.target.checked); localStorage.setItem('edtech.low', e.target.checked ? '1' : '0'); }} /> Low-bandwidth mode</label></>}>
        {playback ? <VideoPlayer key={playback.assetId + playback.mode} topicId={topicId} playback={playback} onProgress={reload} /> : <Loading what="Preparing the lesson" />}
      </Card>

      <Card title="2. Quiz" actions={<Badge tone={quizPassed ? 'ok' : videoDone ? 'warn' : 'muted'}>{quizPassed ? 'Passed' : videoDone ? 'Ready' : 'Locked'}</Badge>}>
        {quizPassed && !keepQuiz ? <p>You passed this quiz.</p> : !videoDone ? <p className="muted">Finish watching the video and answer its questions to unlock the quiz.</p>
          : topic.quiz ? <Quiz topicId={topicId} remaining={row?.quizAttemptsRemaining ?? null} onDone={() => { setKeepQuiz(true); void reload(); }} /> : <p>This topic has no quiz.</p>}
      </Card>

      <Card title="3. Assignment" actions={<Badge tone={submitted ? 'ok' : quizPassed ? 'warn' : 'muted'}>{submitted ? 'Submitted' : quizPassed ? 'Ready' : 'Locked'}</Badge>}>
        {!quizPassed && !submitted ? <p className="muted">Pass the quiz to unlock the assignment.</p>
          : topic.assignment ? <><Assignment topicId={topicId} instructions={topic.assignment.instructions} submitted={submitted} onDone={reload} />{grade && <p><Link to={`/grades/${grade.id}`}>View your grade and feedback</Link> <Badge tone={describeState(grade.state).tone}>{describeState(grade.state).label}</Badge></p>}</> : <p>This topic has no assignment.</p>}
      </Card>
    </div>
  );
}
