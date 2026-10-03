import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { DoubtReportData } from '../api/types';
import { Card, ErrorNote, Loading } from '../components/ui';
import { categoryLabel, pct } from '../lib/doubts';

const Pairs = ({ m, label }: { m: Record<string, number>; label?: (k: string) => string }) => <ul>{Object.entries(m).map(([k, v]) => <li key={k}>{label ? label(k) : k}: <strong>{v}</strong></li>)}</ul>;

export function Report() {
  const [days, setDays] = useState('30'); const [r, setR] = useState<DoubtReportData | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { setR(null); api.get<DoubtReportData>(`/v1/reports/doubts?days=${days}`).then((x) => { setR(x); setError(null); }).catch(setError); }, [days]);
  return (
    <>
      <label htmlFor="dr-d" className="inline">Period</label> <select id="dr-d" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 'auto' }}>{[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      <ErrorNote error={error} />{!r && !error && <Loading what="Building the report" />}
      {r && <>
        <Card title="At a glance"><div className="stats"><div className="stat"><span className="muted">Tickets</span><b>{r.tickets}</b></div><div className="stat"><span className="muted">Still open</span><b>{r.open}</b></div><div className="stat"><span className="muted">Waiting for a teacher</span><b className={r.unassigned ? 'warnnum' : undefined}>{r.unassigned}</b></div><div className="stat"><span className="muted">Replied on time</span><b>{pct(r.slaCompliance)}</b></div></div>
          <ul><li>Average first reply: {r.avgFirstResponseMinutes === null ? 'n/a' : `${r.avgFirstResponseMinutes} minutes`}</li><li>Average time to resolve: {r.avgResolutionHours === null ? 'n/a' : `${r.avgResolutionHours} hours`}</li><li>Average rating: {r.avgRating === null ? 'n/a' : `${r.avgRating} out of 5`}</li><li>Reopened: {pct(r.reopenRate)}</li></ul></Card>
        <Card title="What learners ask about"><div className="cols"><div><h3>Topic</h3><Pairs m={r.byCategory} label={categoryLabel} /></div><div><h3>How it started</h3><Pairs m={r.bySource} label={(k) => ({ MANUAL: 'Learner wrote it', TUTOR: 'Passed on by the AI tutor', AUTO: 'Raised automatically' } as Record<string, string>)[k] ?? k} /></div></div></Card>
        <Card title="By teacher">{!r.teachers.length ? <p>No tickets were assigned in this period.</p> : <table><thead><tr><th>Teacher</th><th>Assigned</th><th>Resolved</th><th>Late</th><th>Rating</th></tr></thead><tbody>{r.teachers.map((t) => <tr key={t.teacherId}><td>{t.name ?? 'Unknown'}</td><td>{t.assigned}</td><td>{t.resolved}</td><td>{t.breaches}</td><td>{t.avgRating ?? 'n/a'}</td></tr>)}</tbody></table>}</Card></>}
    </>
  );
}
