import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { ExamReportData } from '../api/types';
import { useAuth } from '../auth';
import { Card, ErrorNote, Loading } from '../components/ui';
import { bandLabel, barHeights, percent, statusLabel, typeLabel } from '../lib/examops';
import { canSee } from '../lib/roles';

export default function ExamReport() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'examops')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <Report />;
}

const Pairs = ({ m, label }: { m: Record<string, number>; label?: (k: string) => string }) => (Object.keys(m).length ? <ul>{Object.entries(m).map(([k, v]) => <li key={k}>{label ? label(k) : k}: <strong>{v}</strong></li>)}</ul> : <p className="muted">None.</p>);

function Report() {
  const { examId = '' } = useParams(); const [r, setR] = useState<ExamReportData | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { setR(null); api.get<ExamReportData>(`/v1/reports/exams?examId=${encodeURIComponent(examId)}`).then((x) => { setR(x); setError(null); }).catch(setError); }, [examId]);
  const f = r?.funnel;
  return (
    <div>
      <p><Link to="/staff/examops">Back to exam integrity</Link></p>
      <h1>Results report{r ? `: ${r.exam.code}` : ''}</h1>
      <ErrorNote error={error} />{!r && !error && <Loading what="Building the report" />}
      {r && f && <>
        <Card title="How many got through each step"><ol className="funnel">{([['Registered', f.registered], ['Checked in', f.checkedIn], ['Started', f.started], ['Submitted', f.submitted]] as const).map(([l, n]) => <li key={l}>{l}: <strong>{n}</strong></li>)}</ol>
          <p className="muted">Results: {f.released} released, {f.held} held for review, {f.invalidated} invalidated. {f.autoSubmitted} submitted automatically at the deadline.</p></Card>
        <Card title="Scores"><p>{r.results.n ? <>Scored attempts: <strong>{r.results.n}</strong> · average <strong>{r.results.mean}%</strong> · pass rate <strong>{percent(r.results.passRate)}</strong> (pass mark {r.exam.passPercent}%). Invalidated attempts are left out.</> : 'No scored attempts yet.'}</p>
          {r.results.n > 0 && <div className="bars" role="img" aria-label={`Score distribution: ${r.results.distribution.map((n, i) => `${bandLabel(i)}: ${n}`).join(', ')}`}>{barHeights(r.results.distribution).map((h, i) => <div key={i} className="barcol"><span className="barfill" style={{ height: `${h}%` }} title={`${r.results.distribution[i]}`} /><small>{bandLabel(i)}</small></div>)}</div>}
          {r.results.n > 0 && <details><summary>Show the numbers</summary><table><thead><tr><th>Band (%)</th><th>Attempts</th></tr></thead><tbody>{r.results.distribution.map((n, i) => <tr key={i}><td>{bandLabel(i)}</td><td>{n}</td></tr>)}</tbody></table></details>}
          {Object.keys(r.sections).length > 0 && <><h3>Average by section</h3><Pairs m={r.sections} label={(k) => k} /></>}</Card>
        {r.itemAnalysis.length > 0 && <Card title="Hardest questions"><p className="muted">The share of learners who got each question right, lowest first (up to 20). A very low share can mean a faulty question.</p><table><thead><tr><th>Question</th><th>Attempts</th><th>Got it right</th></tr></thead><tbody>{r.itemAnalysis.map((i) => <tr key={i.questionId}><td>{i.questionId.slice(0, 8)}</td><td>{i.attempts}</td><td>{percent(i.pValue)}</td></tr>)}</tbody></table></Card>}
        <Card title="Integrity"><p>{r.integrity.incidents} incident{r.integrity.incidents === 1 ? '' : 's'}; confirmed on {percent(r.integrity.confirmedRate)} of submitted attempts; {r.integrity.sessionTakeovers} attempt{r.integrity.sessionTakeovers === 1 ? '' : 's'} with many window switches.</p>
          <div className="cols"><div><h3>By kind</h3><Pairs m={r.integrity.byType} label={typeLabel} /></div><div><h3>By severity</h3><Pairs m={r.integrity.bySeverity} /></div><div><h3>By decision</h3><Pairs m={r.integrity.byStatus} label={statusLabel} /></div></div></Card>
        <Card title="Appeals"><p>{r.appeals.filed} filed, {r.appeals.overturned} overturned, {r.appeals.open} still open.</p></Card></>}
    </div>
  );
}
