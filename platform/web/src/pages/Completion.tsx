import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Completion, EntitlementSummary } from '../api/types';
import { Badge, Card, ErrorNote, Loading, Progress } from '../components/ui';

export default function CompletionPage() {
  const [c, setC] = useState<Completion | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { (async () => { try { const ents = await api.get<EntitlementSummary[]>('/v1/me/entitlements'); const e = ents.find((x) => x.learningAccess) ?? ents[0]; if (e) setC(await api.get<Completion>(`/v1/me/completion?entitlementId=${e.id}`)); else setError(new Error('none')); } catch (e) { setError(e); } })(); }, []);
  if (error) return <ErrorNote error={error} />;
  if (!c) return <Loading what="Loading your completion status" />;
  return (
    <div><h1>Programme completion</h1>
      {c.programmeComplete && <p className="note ok" role="status">You have met every requirement. Certificates are issued by the institute after verification.</p>}
      <Card title="Topics" actions={<Badge tone={c.topics.complete ? 'ok' : 'warn'}>{c.topics.complete ? 'Complete' : 'In progress'}</Badge>}><Progress value={c.topics.percent} label="Topics" /><p>{c.topics.percent}% of required topics complete.</p></Card>
      <Card title="Labs" actions={<Badge tone={c.labs.complete ? 'ok' : 'warn'}>{c.labs.complete ? 'Complete' : 'Outstanding'}</Badge>}>{c.labs.complete ? <p>All required labs are complete.</p> : <p>Still to do: {c.labs.outstanding.join(', ')}. <Link to="/labs">Go to labs</Link></p>}</Card>
      <Card title="Exams">{c.exams.length ? <ul className="plain">{c.exams.map((e) => <li key={e.code} className="row"><span>{e.code}</span><Badge tone={e.passed ? 'ok' : 'warn'}>{e.passed ? 'Passed' : 'Not passed yet'}</Badge></li>)}</ul> : <p>No exams for this programme.</p>}<Link to="/exams">Go to exams</Link></Card>
    </div>
  );
}
