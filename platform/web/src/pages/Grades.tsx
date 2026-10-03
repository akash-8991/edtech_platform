import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { EntitlementSummary, Progress, SubmissionSummary } from '../api/types';
import { Badge, Card, Hold } from '../components/ui';
import { describeState, pct } from '../lib/grades';
import { fmtDateTime, useT } from '../lib/i18n';

export default function Grades() {
  const tt = useT(); const [rows, setRows] = useState<SubmissionSummary[] | null>(null); const [titles, setTitles] = useState<Map<string, string>>(new Map()); const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    (async () => {
      try {
        const [subs, ents] = await Promise.all([api.get<SubmissionSummary[]>('/v1/me/submissions'), api.get<EntitlementSummary[]>('/v1/me/entitlements')]);
        const names = new Map<string, string>();
        await Promise.all(ents.filter((e) => e.learningAccess).map(async (e) => { const p = await api.get<Progress>(`/v1/me/entitlements/${e.id}/progress`).catch(() => null); p?.topics.forEach((x) => names.set(x.topicId, x.title)); }));
        setTitles(names); setRows(subs);
      } catch (e) { setError(e); }
    })();
  }, []);
  if (error || !rows) return <Hold title={tt('Assignment grades')} error={error} what={tt('Loading your grades')} />;
  return (
    <div>
      <h1>{tt('Assignment grades')}</h1>
      {!rows.length ? <Card><p>{tt("You have not submitted any assignments yet. After you pass a topic's quiz you can submit its assignment.")}</p></Card> : (
        <ul className="plain">{rows.map((r) => { const s = describeState(r.state); return (
          <li key={r.submissionId}><Card title={<Link to={`/grades/${r.submissionId}`}>{titles.get(r.topicId) ?? tt('Assignment')}{r.attemptNo ? ` (${tt('attempt {n}', { n: r.attemptNo })})` : ''}</Link>} actions={<Badge tone={s.tone}>{s.label}</Badge>}>
            <p className="muted">{r.submittedAt ? tt('Submitted {when}', { when: fmtDateTime(r.submittedAt) }) : ''}</p>
            {typeof r.finalPercent === 'number' && <p><strong>{pct(r.finalPercent)}</strong> {r.passed ? `· ${tt('passed')}` : r.passed === false ? `· ${tt('not passed')}` : ''}</p>}
          </Card></li>); })}</ul>)}
    </div>
  );
}
