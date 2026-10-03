import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AiJob } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { AI_GEN, curriculumBody, curriculumProblem, emptyCurriculum, jobLabel, jobTone, kindLabel, type CurriculumForm } from '../lib/aigen';
import { canSee, hasAny } from '../lib/roles';

export default function AiGenerate() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'content') || !hasAny(me?.roles, AI_GEN)) return <Navigate to="/staff/content" replace />; // checked before anything is fetched
  return <Page />;
}

function Page() {
  const nav = useNavigate(); const [f, setF] = useState<CurriculumForm>(emptyCurriculum()); const [problem, setProblem] = useState<string | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<AiJob[] | null>(null);
  useEffect(() => { api.get<AiJob[]>('/v1/ai/jobs').then(setJobs).catch(() => setJobs([])); }, []);
  const set = <K extends keyof CurriculumForm>(k: K, v: CurriculumForm[K]) => { setF((x) => ({ ...x, [k]: v })); setProblem(null); };
  const submit = async () => {
    const p = curriculumProblem(f); setProblem(p); if (p) return; setBusy(true); setError(null);
    try { const r = await api.post<{ jobId: string }>('/v1/ai/curriculum-jobs', curriculumBody(f)); nav(`/staff/content/jobs/${r.jobId}`); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div>
      <p><Link to="/staff/content">Back to content</Link></p>
      <h1>Write a course with AI</h1>
      <p className="muted">Describe the course. The AI drafts modules, topics, a script for each lesson video, quizzes and assignments, in the languages you choose. <strong>It is only ever a draft:</strong> you edit it, it passes quality checks, and it goes through faculty review and approval like anything you wrote yourself. Nothing reaches a learner until it is published.</p>
      <Card title="What should the course be?">
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
          <div className="choices"><div style={{ flex: 1 }}><label htmlFor="ag-code">Programme code</label><input id="ag-code" value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="IOT-101" /></div>
            <div style={{ flex: 3 }}><label htmlFor="ag-title">Title</label><input id="ag-title" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Introduction to the Internet of Things" /></div></div>
          <label htmlFor="ag-disc">Discipline</label><input id="ag-disc" value={f.discipline} onChange={(e) => set('discipline', e.target.value)} placeholder="Electronics" />
          <label htmlFor="ag-aud">Who is it for?</label><input id="ag-aud" value={f.audience} onChange={(e) => set('audience', e.target.value)} placeholder="First-year diploma students with no programming background" />
          <div className="choices"><div><label htmlFor="ag-dur">Duration</label><select id="ag-dur" value={f.durationType} onChange={(e) => set('durationType', e.target.value as 'M12' | 'M18')} style={{ width: 'auto' }}><option value="M12">12 months</option><option value="M18">18 months</option></select></div>
            <div><label htmlFor="ag-hours">Total hours of study</label><input id="ag-hours" inputMode="numeric" value={f.hours} onChange={(e) => set('hours', e.target.value)} style={{ width: '7rem' }} /></div></div>
          <label htmlFor="ag-out">Learning outcomes (one per line)</label><textarea id="ag-out" rows={5} value={f.outcomes} onChange={(e) => set('outcomes', e.target.value)} placeholder={'Explain what a sensor does\nWire a temperature sensor to a microcontroller'} />
          <p className="muted">These matter most: the AI plans the course around them and its output is checked against them.</p>
          <label htmlFor="ag-pre">Prerequisites (one per line, optional)</label><textarea id="ag-pre" rows={2} value={f.prerequisites} onChange={(e) => set('prerequisites', e.target.value)} />
          <fieldset><legend>Languages</legend><label className="inline"><input type="checkbox" checked disabled /> English (always)</label> <label className="inline"><input type="checkbox" checked={f.languages.includes('hi')} onChange={(e) => set('languages', e.target.checked ? ['en', 'hi'] : ['en'])} /> Hindi as well</label></fieldset>
          <details><summary>Reference material (optional)</summary>
            <p className="muted">Paste text the AI must stay faithful to: a syllabus, a textbook chapter, your notes. It writes from this and the quality checks verify citations against it. It is treated as data, never as instructions.</p>
            <label htmlFor="ag-rt">Name of the reference</label><input id="ag-rt" value={f.refTitle} onChange={(e) => set('refTitle', e.target.value)} />
            <label htmlFor="ag-rx">Text</label><textarea id="ag-rx" rows={8} value={f.refText} onChange={(e) => set('refText', e.target.value)} /></details>
          {problem && <p role="alert" className="note error">{problem}</p>}<ErrorNote error={error} />
          <button disabled={busy}>{busy ? 'Sending…' : 'Write the course'}</button>
          <p className="muted">It takes a few minutes. You can leave the page: the job runs on the server and appears in the list below.</p>
        </form>
      </Card>
      <Card title="Recent AI jobs">
        {!jobs ? <Loading what="Loading jobs" /> : !jobs.length ? <p className="muted">None yet.</p> : <div className="scroll"><table><thead><tr><th>Started</th><th>What</th><th>Status</th><th>Cost</th></tr></thead><tbody>{jobs.slice(0, 15).map((j) => (
          <tr key={j.id}><td><Link to={`/staff/content/jobs/${j.id}`}>{new Date(j.createdAt).toLocaleString()}</Link></td><td>{kindLabel(j.kind)}</td><td><Badge tone={jobTone(j.status)}>{jobLabel(j.status)}</Badge></td><td>{j.costUsd ? `$${j.costUsd.toFixed(3)}` : '—'}</td></tr>))}</tbody></table></div>}
      </Card>
    </div>
  );
}
