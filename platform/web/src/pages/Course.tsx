import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Progress } from '../api/types';
import { Badge, Card, ErrorNote, Loading, Progress as Bar } from '../components/ui';
import { describeState } from '../lib/grades';

export default function Course() {
  const { entitlementId = '' } = useParams(); const [p, setP] = useState<Progress | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.get<Progress>(`/v1/me/entitlements/${entitlementId}/progress`).then(setP).catch(setError); }, [entitlementId]);
  if (error) return <ErrorNote error={error} />;
  if (!p) return <Loading what="Loading your progress" />;
  return (
    <div>
      <p><Link to="/">All courses</Link></p>
      <h1>Your progress</h1>
      <Bar value={p.percentComplete} label="Course progress" /><p>{p.percentComplete}% of required topics complete</p>
      <ol className="topics">
        {p.topics.map((t, i) => (
          <li key={t.topicId}>
            <Card title={t.unlocked ? <Link to={`/courses/${entitlementId}/topics/${t.topicId}`}>{i + 1}. {t.title}</Link> : <span>{i + 1}. {t.title}</span>}
              actions={t.complete ? <Badge tone="ok">Complete</Badge> : t.unlocked ? <Badge tone="warn">In progress</Badge> : <Badge tone="muted">Locked</Badge>}>
              {t.unlocked ? (
                <ul className="steps" aria-label="Steps to complete this topic">
                  <li className={t.videoDone ? 'done' : ''}>{t.videoDone ? '✓' : '○'} Watch the video</li>
                  <li className={t.quizPassed ? 'done' : ''}>{t.quizPassed ? '✓' : '○'} Pass the quiz</li>
                  <li className={t.assignmentSubmitted ? 'done' : ''}>{t.assignmentSubmitted ? '✓' : '○'} Submit the assignment{t.assignmentState ? <span className="muted"> ({describeState(t.assignmentState).label.toLowerCase()})</span> : null}</li>
                </ul>) : <p className="muted">Finish the previous topic to unlock this one.</p>}
            </Card>
          </li>))}
      </ol>
    </div>
  );
}
