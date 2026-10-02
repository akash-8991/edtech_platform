import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { EntitlementSummary, LabActivity, Progress } from '../api/types';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { blockers, labStatus, liveBooking, slotTime } from '../lib/labs';

export default function Labs() {
  const [labs, setLabs] = useState<LabActivity[] | null>(null); const [titles, setTitles] = useState<Map<string, string>>(new Map()); const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    (async () => {
      try {
        const [l, ents] = await Promise.all([api.get<LabActivity[]>('/v1/me/labs'), api.get<EntitlementSummary[]>('/v1/me/entitlements')]);
        const t = new Map<string, string>(); await Promise.all(ents.filter((e) => e.learningAccess).map(async (e) => { (await api.get<Progress>(`/v1/me/entitlements/${e.id}/progress`).catch(() => null))?.topics.forEach((x) => t.set(x.topicId, x.title)); }));
        setTitles(t); setLabs(l);
      } catch (e) { setError(e); }
    })();
  }, []);
  if (error) return <ErrorNote error={error} />;
  if (!labs) return <Loading what="Loading your labs" />;
  const done = labs.filter((l) => l.completed).length;
  return (
    <div>
      <h1>Labs</h1>
      {!labs.length ? <Card><p>Your programme has no lab sessions.</p></Card> : (<>
        <p className="muted">{done} of {labs.length} completed. Mandatory labs must be completed before the final exam.</p>
        <ul className="plain">{labs.map((l) => { const s = labStatus(l); const b = liveBooking(l); const why = s.state === 'blocked' ? blockers(l, titles) : []; return (
          <li key={l.activityId}><Card title={<Link to={`/labs/${l.activityId}`}>{l.title}</Link>} actions={<><Badge tone={s.tone}>{s.label}</Badge>{l.mandatory && <Badge tone="muted">Mandatory</Badge>}</>}>
            {l.location && <p className="muted">Location: {l.location}</p>}
            {b?.slot && <p>Your session: <strong>{slotTime(b.slot)}</strong>{b.slot.location ? ` · ${b.slot.location}` : ''}</p>}
            {why.length > 0 && <ul aria-label="What you need to do first">{why.map((w) => <li key={w}>{w}</li>)}</ul>}
          </Card></li>); })}</ul></>)}
    </div>
  );
}
