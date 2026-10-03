import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { GradingReportData, ProgrammeRow } from '../api/types';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { age, backlogWarn, barHeights, biasText, money, pct, reasonLabel, sampleNote, stateRows, versionText } from '../lib/gradingreport';

const Stat = ({ label, v, warn }: { label: string; v: string | number; warn?: boolean }) => <div className="stat"><span className="muted">{label}</span><b className={warn ? 'warnnum' : undefined}>{v}</b></div>;

/** How grading is going: where marks land, how often the AI and people agree, how much goes to a person, appeals, integrity, backlog and cost. Read-only. */
export default function GradingReport() {
  const [days, setDays] = useState('30'); const [versionId, setVersionId] = useState(''); const [versions, setVersions] = useState<{ id: string; label: string }[]>([]); const [r, setR] = useState<GradingReportData | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.get<ProgrammeRow[]>('/v1/authoring/programmes').then((ps) => setVersions(ps.flatMap((p) => p.versions.filter((v) => v.state === 'PUBLISHED' || v.state === 'RETIRED').map((v) => ({ id: v.id, label: `${p.title}, version ${v.version}` }))))).catch(() => setVersions([])); }, []); // the course filter is optional: not every role may list courses
  useEffect(() => { setR(null); const q = new URLSearchParams({ days }); if (versionId) q.set('versionId', versionId); api.get<GradingReportData>(`/v1/reports/grading?${q}`).then((x) => { setR(x); setError(null); }).catch(setError); }, [days, versionId]);
  const a = r?.aiHumanAgreement; const heights = r ? barHeights(r.scoreDistribution) : [];
  return (
    <>
      <div className="choices"><label htmlFor="gr-d">Period</label><select id="gr-d" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 'auto' }}>{[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last year']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {versions.length > 0 && <><label htmlFor="gr-v">Course</label><select id="gr-v" value={versionId} onChange={(e) => setVersionId(e.target.value)} style={{ width: 'auto' }}><option value="">All courses</option>{versions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></>}</div>
      <ErrorNote error={error} />{!r && !error && <Loading what="Building the report" />}
      {r && a && <>
        <Card title="At a glance"><div className="stats"><Stat label="Submissions" v={r.submissions} /><Stat label="Needed a person" v={pct(r.moderationRate)} /><Stat label="Appealed" v={pct(r.appeals.rate)} /><Stat label="Appeals overturned" v={pct(r.appeals.overturnRate)} /><Stat label="AI confidence (average)" v={!r.avgAiConfidence ? 'n/a' : `${Math.round(r.avgAiConfidence * 100)}%`} /><Stat label="AI marking cost" v={money(r.costUsd)} /></div></Card>
        <Card title="Waiting right now" actions={<Badge tone={backlogWarn(r.backlog) ? 'warn' : 'ok'}>{backlogWarn(r.backlog) ? 'Work is waiting' : 'Nothing waiting'}</Badge>}>
          <ul><li>Waiting for the AI: <strong>{r.backlog.pendingAi}</strong>{r.backlog.pendingAi ? `, the oldest for ${age(r.backlog.oldestPendingMinutes)}` : ''}</li><li>Waiting for a human grader: <strong>{r.backlog.openModeration}</strong>{r.backlog.openModeration ? `, the oldest for ${age(r.backlog.oldestModerationMinutes)}` : ''}</li></ul></Card>
        <Card title="Where marks land"><p className="muted">Final marks for the {r.scoreDistribution.reduce((n, x) => n + x.count, 0)} graded submissions in this period.</p>
          {r.scoreDistribution.some((x) => x.count > 0) ? <><div className="bars" role="img" aria-label={`Mark distribution: ${r.scoreDistribution.map((x) => `${x.range}%: ${x.count}`).join(', ')}`}>{r.scoreDistribution.map((x, i) => <div key={x.range} className="barcol"><span className="barfill" style={{ height: `${heights[i]}%` }} title={String(x.count)} /><small>{x.range}</small></div>)}</div>
            <details><summary>Show the numbers</summary><table><thead><tr><th>Mark (%)</th><th>Submissions</th></tr></thead><tbody>{r.scoreDistribution.map((x) => <tr key={x.range}><td>{x.range}</td><td>{x.count}</td></tr>)}</tbody></table></details></> : <p>No marks yet.</p>}
          <h3>By state</h3><ul>{stateRows(r).map((s) => <li key={s.label}>{s.label}: <strong>{s.n}</strong></li>)}</ul></Card>
        <Card title="Does the AI agree with people?">
          {a.pairs === 0 ? <p>No submission has been graded both by the AI and by a person in this period.</p> : <>
            <ul><li>Graded both ways: <strong>{a.pairs}</strong></li><li>Within {a.tolerancePct} points of each other: <strong>{pct(a.agreementRate)}</strong></li><li>Average difference: <strong>{a.meanAbsDiffPct} points</strong></li></ul><p>{biasText(a.humanMinusAiBiasPct)}</p>{sampleNote(a.pairs) && <p className="note">{sampleNote(a.pairs)}</p>}
            {Object.keys(a.perDimensionMAEPct).length > 0 && <><h3>Average difference by criterion</h3><table><thead><tr><th>Criterion</th><th>Average difference (% of the scale)</th></tr></thead><tbody>{Object.entries(a.perDimensionMAEPct).map(([k, v]) => <tr key={k}><td>{k.replace(/_/g, ' ')}</td><td>{v ?? 'n/a'}</td></tr>)}</tbody></table></>}</>}
        </Card>
        <Card title="Why work goes to a person">{!Object.keys(r.moderationReasons).length ? <p>Nothing was sent to a person in this period.</p> : <ul>{Object.entries(r.moderationReasons).sort((x, y) => y[1] - x[1]).map(([k, n]) => <li key={k}>{reasonLabel(k)}: <strong>{n}</strong></li>)}</ul>}</Card>
        <Card title="Appeals and integrity"><ul><li>Appealed: <strong>{r.appeals.appealed}</strong>; overturned: <strong>{r.appeals.overturned}</strong></li><li>Flagged for similarity or other integrity signals: <strong>{r.integrity.flaggedSubmissions}</strong>; concern confirmed: <strong>{r.integrity.confirmedConcerns}</strong>; cleared: <strong>{r.integrity.cleared}</strong></li></ul></Card>
        <Card title="Which AI marked">{!Object.keys(r.graderVersions).length ? <p>No AI marking in this period.</p> : <ul>{Object.entries(r.graderVersions).map(([k, n]) => <li key={k}>{versionText(k)}: <strong>{n}</strong> submission{n === 1 ? '' : 's'}</li>)}</ul>}<p className="muted">Figures cover work submitted since {new Date(r.since).toLocaleDateString()}.</p></Card></>}
    </>
  );
}
