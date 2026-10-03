import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../api/client';
import type { CatalogueItem, ProgressReportData, TutorReportData } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading, Progress } from '../components/ui';
import { canSee, hasAny, REPORTS } from '../lib/roles';
import { Report as DoubtsReport } from './DoubtReport';
import ExamList from './ExamList';
import GradingReport from './GradingReport';

type Tab = 'progress' | 'exams' | 'grading' | 'doubts' | 'tutor';
const TITLES: Record<Tab, string> = { progress: 'Learner progress', exams: 'Exam results', grading: 'Grading', doubts: 'Doubt desk', tutor: 'AI tutor' };

export default function Reports() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'reports')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  const tabs = (Object.keys(TITLES) as Tab[]).filter((t) => hasAny(me!.roles, REPORTS[t]));
  return <Hub tabs={tabs} />;
}

function Hub({ tabs }: { tabs: Tab[] }) {
  const [tab, setTab] = useState<Tab>(tabs[0]);
  return (
    <div>
      <h1>Reports</h1>
      <p className="muted">Numbers come from the live platform. Anyone exporting learner data is recorded in the audit trail.</p>
      <div className="tabs" role="group" aria-label="Report">{tabs.map((t) => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{TITLES[t]}</button>)}</div>
      {tab === 'progress' ? <ProgressReport /> : tab === 'exams' ? <ExamList canRelease={false} canSweep={false} canCase={false} /> : tab === 'grading' ? <GradingReport /> : tab === 'doubts' ? <DoubtsReport /> : <TutorReport />}
    </div>
  );
}

export function ProgressReport() {
  const [versions, setVersions] = useState<CatalogueItem[] | null>(null); const [versionId, setVersionId] = useState(''); const [cohort, setCohort] = useState(''); const [applied, setApplied] = useState<{ v: string; c: string } | null>(null);
  const [data, setData] = useState<ProgressReportData | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [riskOnly, setRiskOnly] = useState(false); const [more, setMore] = useState(false);
  useEffect(() => { api.get<CatalogueItem[]>('/v1/catalogue').then((v) => { setVersions(v); if (v[0]) { setVersionId(v[0].versionId); setApplied({ v: v[0].versionId, c: '' }); } }).catch(setError); }, []);
  const q = (a: { v: string; c: string }, extra = '') => `/v1/reports/progress?versionId=${encodeURIComponent(a.v)}&limit=200${a.c.trim() ? `&cohort=${encodeURIComponent(a.c.trim())}` : ''}${extra}`;
  useEffect(() => { if (!applied) return; setData(null); api.get<ProgressReportData>(q(applied)).then((d) => { setData(d); setError(null); }).catch(setError); }, [applied]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadMore = async () => { if (!applied || !data?.nextCursor) return; setMore(true); try { const d = await api.get<ProgressReportData>(q(applied, `&cursor=${encodeURIComponent(data.nextCursor)}`)); setData({ ...d, rows: [...data.rows, ...d.rows], summary: { ...d.summary, learners: data.rows.length + d.rows.length } }); } catch (e) { setError(e); } finally { setMore(false); } };
  const exportCsv = async () => {
    if (!applied) return; setBusy(true); setError(null);
    try { const blob = await api.download(`/v1/reports/progress?versionId=${encodeURIComponent(applied.v)}&format=csv${applied.c.trim() ? `&cohort=${encodeURIComponent(applied.c.trim())}` : ''}`); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'progress.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const rows = (data?.rows ?? []).filter((r) => !riskOnly || r.atRisk);
  return (
    <>
      <form className="choices" onSubmit={(e) => { e.preventDefault(); if (versionId) setApplied({ v: versionId, c: cohort }); }}>
        <label htmlFor="pr-v">Programme version</label><select id="pr-v" value={versionId} onChange={(e) => setVersionId(e.target.value)} style={{ width: 'auto' }}>{(versions ?? []).map((v) => <option key={v.versionId} value={v.versionId}>{v.code} · {v.title}</option>)}</select>
        <label htmlFor="pr-c">Cohort (optional)</label><input id="pr-c" value={cohort} onChange={(e) => setCohort(e.target.value)} style={{ width: 'auto' }} /><button>Show</button>
      </form>
      <ErrorNote error={error} />{versions && !versions.length && <Card><p>No programme has been published yet.</p></Card>}{applied && !data && !error && <Loading what="Building the report" />}
      {data && <>
        <Card title="At a glance" actions={<button onClick={() => void exportCsv()} disabled={busy}>{busy ? 'Preparing…' : 'Download CSV'}</button>}>
          <div className="stats"><div className="stat"><span className="muted">Learners</span><b>{data.summary.learners}</b></div><div className="stat"><span className="muted">Average progress</span><b>{data.summary.avgPercent}%</b></div><div className="stat"><span className="muted">At risk</span><b className={data.summary.atRisk ? 'warnnum' : undefined}>{data.summary.atRisk}</b></div></div>
          <p className="muted">At risk means active, not finished, and no learning activity for 14 days or more.</p>
          <label className="inline"><input type="checkbox" checked={riskOnly} onChange={(e) => setRiskOnly(e.target.checked)} /> Show only learners at risk</label></Card>
        <Card>{!rows.length ? <p>No learners to show.</p> : <div className="scroll"><table><thead><tr><th>Learner</th><th>Cohort</th><th>Progress</th><th>Quiz attempts</th><th>Last activity</th><th>Status</th></tr></thead><tbody>{rows.map((r) => (
          <tr key={r.email}><td>{r.learner}<br /><span className="muted">{r.email}</span></td><td>{r.cohort}</td><td style={{ minWidth: 140 }}><Progress value={r.percent} label={`${r.learner} progress`} /><span className="muted">{r.completedTopics} of {r.totalTopics} topics ({r.percent}%)</span></td><td>{r.quizAttempts}</td><td>{new Date(r.lastActivity).toLocaleDateString()}<br /><span className="muted">{r.daysIdle} days ago</span></td><td>{r.atRisk ? <Badge tone="warn">At risk</Badge> : <Badge tone={r.status === 'ACTIVE' ? 'ok' : 'muted'}>{r.status.toLowerCase()}</Badge>}</td></tr>))}</tbody></table></div>}
          {data.nextCursor && <p><button onClick={() => void loadMore()} disabled={more}>{more ? 'Loading…' : 'Show more'}</button></p>}</Card></>}
    </>
  );
}

export function TutorReport() {
  const [days, setDays] = useState('30'); const [r, setR] = useState<TutorReportData | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { setR(null); api.get<TutorReportData>(`/v1/reports/tutor?days=${days}`).then((x) => { setR(x); setError(null); }).catch(setError); }, [days]);
  const pct = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * (x <= 1 ? 100 : 1))}%`);
  return (
    <>
      <label htmlFor="tr-d" className="inline">Period</label> <select id="tr-d" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 'auto' }}>{[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <ErrorNote error={error} />{!r && !error && <Loading what="Building the report" />}
      {r && <>
        <Card title="At a glance"><div className="stats"><div className="stat"><span className="muted">Questions asked</span><b>{r.questions}</b></div><div className="stat"><span className="muted">Answers grounded in the course</span><b>{pct(r.groundedAnswerRate)}</b></div><div className="stat"><span className="muted">Declined to answer</span><b>{pct(r.refusalRate)}</b></div><div className="stat"><span className="muted">Found helpful</span><b>{pct(r.helpfulRate)}</b></div><div className="stat"><span className="muted">Passed to a teacher</span><b>{r.escalatedTickets}</b></div></div></Card>
        <Card title="How the questions ended"><ul>{Object.entries(r.byStatus).map(([k, v]) => <li key={k}>{k.toLowerCase()}: <strong>{v}</strong></li>)}</ul></Card>
        <Card title="Questions the tutor could not answer">{!r.topUnresolvedTerms.length ? <p>None in this period.</p> : <ul>{r.topUnresolvedTerms.map((t) => <li key={t.term}>{t.term} <span className="muted">({t.count})</span></li>)}</ul>}<p className="muted">Frequent gaps usually mean the course content is missing something.</p></Card>
      </>}
    </>
  );
}
