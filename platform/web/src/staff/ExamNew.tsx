import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { BankCoverage, ExamDetail, ExamSetupInfo } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { blankExam, blueprintStatus, tagsOf, toBody, toLines, totalBank, validateExam, type ExamForm } from '../lib/examsetup';
import { canSee, EXAMSETUP, hasAny } from '../lib/roles';

export default function ExamNew() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'examsetup') || !hasAny(me?.roles, EXAMSETUP.create)) return <Navigate to="/staff/examsetup" replace />; // checked before anything is fetched
  return <Form />;
}

function Form() {
  const nav = useNavigate(); const [setup, setSetup] = useState<ExamSetupInfo | null>(null); const [f, setF] = useState<ExamForm>(blankExam()); const [cov, setCov] = useState<BankCoverage[] | null>(null);
  const [problems, setProblems] = useState<string[]>([]); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<ExamSetupInfo>('/v1/exam-ops/setup').then((s) => { setSetup(s); if (s.versions[0]) setF((x) => ({ ...x, versionId: s.versions[0].versionId })); }).catch(setError); }, []);
  const ver = setup?.versions.find((v) => v.versionId === f.versionId);
  useEffect(() => { setCov(null); if (ver) api.get<BankCoverage[]>(`/v1/exams/bank/${ver.programmeId}/coverage`).then(setCov).catch(setError); }, [ver?.programmeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<ExamForm>) => { setF({ ...f, ...p }); setProblems([]); };
  const setLine = (i: number, p: Partial<ExamForm['lines'][0]>) => set({ lines: f.lines.map((l, k) => (k === i ? { ...l, ...p } : l)) });
  const submit = async () => {
    const p = validateExam(f, cov); setProblems(p); if (p.length) return; setBusy(true); setError(null);
    try { const e = await api.post<ExamDetail>('/v1/exams', toBody(f)); nav(`/staff/examsetup/exams/${e.id}`); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  if (!setup) return <div><p><Link to="/staff/examsetup">Back to exam set-up</Link></p><h1>Define an exam</h1><ErrorNote error={error} />{!error && <Loading />}</div>;
  if (setup.changeFrozen) return <div><p><Link to="/staff/examsetup">Back to exam set-up</Link></p><h1>Define an exam</h1><p role="alert" className="note error">Exam changes are frozen right now, so a new exam cannot be defined.</p></div>;
  if (!setup.versions.length) return <div><p><Link to="/staff/examsetup">Back to exam set-up</Link></p><h1>Define an exam</h1><Card><p>An exam is defined on a published course, and none is published yet. Publish a course first (Content).</p></Card></div>;
  const status = cov ? blueprintStatus(toLines(f), cov) : [];
  return (
    <div>
      <p><Link to="/staff/examsetup">Back to exam set-up</Link></p>
      <h1>Define an exam</h1>
      <p className="muted">It starts as a draft. Another administrator checks and publishes it; then you can schedule sittings.</p>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        <Card title="The exam">
          <label htmlFor="en-v">Course</label><select id="en-v" value={f.versionId} onChange={(e) => set({ versionId: e.target.value, lines: f.lines.map((l) => ({ ...l, tag: '' })) })}>{setup.versions.map((v) => <option key={v.versionId} value={v.versionId}>{v.title} ({v.code}), version {v.version}</option>)}</select>
          <label htmlFor="en-c">Exam code</label><input id="en-c" value={f.code} onChange={(e) => set({ code: e.target.value })} /> <label htmlFor="en-t">Title (optional)</label><input id="en-t" value={f.title} onChange={(e) => set({ title: e.target.value })} />
          <div className="choices"><label htmlFor="en-d">Minutes</label><input id="en-d" inputMode="numeric" value={f.durationMin} onChange={(e) => set({ durationMin: e.target.value })} style={{ width: '5rem' }} /><label htmlFor="en-p">Pass mark (%)</label><input id="en-p" inputMode="numeric" value={f.passPercent} onChange={(e) => set({ passPercent: e.target.value })} style={{ width: '5rem' }} /><label htmlFor="en-a">Attempts allowed</label><input id="en-a" inputMode="numeric" value={f.maxAttempts} onChange={(e) => set({ maxAttempts: e.target.value })} style={{ width: '4rem' }} /><label htmlFor="en-w">Days between attempts</label><input id="en-w" inputMode="numeric" value={f.cooldownDays} onChange={(e) => set({ cooldownDays: e.target.value })} style={{ width: '4rem' }} /></div>
          <label className="inline"><input type="checkbox" checked={f.shuffle} onChange={(e) => set({ shuffle: e.target.checked })} /> Shuffle the order of answer options for each learner</label>
        </Card>
        <Card title="Who may sit it">
          <div className="choices"><label htmlFor="en-m">Course completion needed (%)</label><input id="en-m" inputMode="numeric" value={f.minProgrammePercent} onChange={(e) => set({ minProgrammePercent: e.target.value })} style={{ width: '5rem' }} /></div>
          <fieldset><legend>Labs</legend><label className="inline"><input type="radio" name="labs" checked={f.labs === 'ALL_MANDATORY'} onChange={() => set({ labs: 'ALL_MANDATORY' })} /> All mandatory labs completed</label> <label className="inline"><input type="radio" name="labs" checked={f.labs === 'LIST'} onChange={() => set({ labs: 'LIST' })} /> Only these labs</label>{f.labs === 'LIST' && <><label htmlFor="en-l">Lab codes (comma separated)</label><input id="en-l" value={f.labList} onChange={(e) => set({ labList: e.target.value })} /></>}</fieldset>
          <label htmlFor="en-aa">Assignment average needed (%, optional)</label><input id="en-aa" inputMode="decimal" value={f.minAssignmentAverage} onChange={(e) => set({ minAssignmentAverage: e.target.value })} style={{ width: '6rem' }} />
          <label className="inline" style={{ display: 'block' }}><input type="checkbox" checked={f.requireAssignmentsReleased} onChange={(e) => set({ requireAssignmentsReleased: e.target.checked })} /> No assignment may still be waiting to be marked</label>
          <label className="inline" style={{ display: 'block' }}><input type="checkbox" checked={f.blockOnIntegrity} onChange={(e) => set({ blockOnIntegrity: e.target.checked })} /> Block anyone with an open academic-integrity case</label>
        </Card>
        <Card title="How it is supervised">
          <fieldset><legend>Where it is sat</legend><label className="inline"><input type="radio" name="mode" checked={f.mode === 'REMOTE'} onChange={() => set({ mode: 'REMOTE' })} /> Remote, online with a proctoring service</label> <label className="inline"><input type="radio" name="mode" checked={f.mode === 'CENTRE'} onChange={() => set({ mode: 'CENTRE' })} /> At a centre with an invigilator</label></fieldset>
          <label className="inline" style={{ display: 'block' }}><input type="checkbox" checked={f.requireId} onChange={(e) => set({ requireId: e.target.checked })} /> Check photo ID</label>
          <fieldset><legend>The learner's device must have</legend><label className="inline"><input type="checkbox" checked={f.camera} onChange={(e) => set({ camera: e.target.checked })} /> A camera</label> <label className="inline"><input type="checkbox" checked={f.microphone} onChange={(e) => set({ microphone: e.target.checked })} /> A microphone</label> <label className="inline"><input type="checkbox" checked={f.singleScreen} onChange={(e) => set({ singleScreen: e.target.checked })} /> Only one screen</label></fieldset>
        </Card>
        <Card title="What is in the paper (blueprint)">
          <p className="muted">Each section draws a number of questions with a topic tag from the question bank{cov ? ` (it holds ${totalBank(cov)} for this course)` : ''}. Every learner gets a different mix.</p>
          {!cov ? <Loading /> : !cov.length ? <p className="note error">This course has no questions in its bank yet. Add questions first (Question bank tab).</p> : f.lines.map((l, i) => { const st = blueprintStatus(toLines({ ...f, lines: [l] }), cov)[0];
            return (
              <div key={i} className="subcard"><div className="choices">
                <label htmlFor={`bl-t-${i}`}>Section {i + 1}: topic</label><select id={`bl-t-${i}`} value={l.tag} onChange={(e) => setLine(i, { tag: e.target.value })}><option value="">Choose…</option>{tagsOf(cov).map((t) => <option key={t} value={t}>{t}</option>)}</select>
                <label htmlFor={`bl-n-${i}`}>Questions</label><input id={`bl-n-${i}`} inputMode="numeric" value={l.count} onChange={(e) => setLine(i, { count: e.target.value })} style={{ width: '4rem' }} />
                <label htmlFor={`bl-lo-${i}`}>Easiest</label><select id={`bl-lo-${i}`} value={l.minDifficulty} onChange={(e) => setLine(i, { minDifficulty: e.target.value })} style={{ width: 'auto' }}><option value="">Any</option>{[1, 2, 3, 4, 5].map((d) => <option key={d}>{d}</option>)}</select>
                <label htmlFor={`bl-hi-${i}`}>Hardest</label><select id={`bl-hi-${i}`} value={l.maxDifficulty} onChange={(e) => setLine(i, { maxDifficulty: e.target.value })} style={{ width: 'auto' }}><option value="">Any</option>{[1, 2, 3, 4, 5].map((d) => <option key={d}>{d}</option>)}</select>
                {f.lines.length > 1 && <button type="button" className="link" onClick={() => set({ lines: f.lines.filter((_, k) => k !== i) })}>Remove section {i + 1}</button>}</div>
                {l.tag && st && <p>{st.errors.length ? <Badge tone="warn">Not enough questions</Badge> : st.warnings.length ? <Badge tone="warn">Papers will overlap</Badge> : <Badge tone="ok">Enough questions</Badge>} <span className="muted">The bank has {st.have} matching question{st.have === 1 ? '' : 's'}.</span></p>}
              </div>); })}
          <button type="button" onClick={() => set({ lines: [...f.lines, { tag: '', count: '5', minDifficulty: '', maxDifficulty: '' }] })}>Add a section</button>
          {status.length > 0 && <p className="muted">Total: {toLines(f).reduce((n, l) => n + (l.count || 0), 0)} questions per paper.</p>}
        </Card>
        {problems.length > 0 && <div role="alert" className="note error"><p>Please fix:</p><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}<ErrorNote error={error} />
        <p><button disabled={busy}>{busy ? 'Saving…' : 'Save as a draft'}</button></p>
      </form>
    </div>
  );
}
