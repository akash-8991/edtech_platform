import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, messageFor } from '../api/client';
import type { A11yReport, AiJob, DiffChange, ProgrammeRow, QualityFinding, VersionTree } from '../api/types';
import { AI_GEN, jobLabel, jobTone, kindLabel, topicBody, topicProblem } from '../lib/aigen';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { describeChange, isDraft, movesFor, readinessIssues, stateLabel, stateTone, topicStatus, waitingOn } from '../lib/content';
import { AREAS, canSee, hasAny } from '../lib/roles';
import { Editor } from './ContentEdit';

export default function ContentVersion() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'content')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <Page roles={me!.roles} meId={me!.id} />;
}

function Page({ roles, meId }: { roles: string[]; meId: string }) {
  const { versionId = '' } = useParams();
  const [t, setT] = useState<VersionTree | null>(null); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[] | null>(null); const [quality, setQuality] = useState<QualityFinding[]>([]); const [a11y, setA11y] = useState<A11yReport | null>(null); const [prev, setPrev] = useState<string | null>(null);
  const load = useCallback(async (clear = true) => {
    try {
      const x = await api.get<VersionTree>(`/v1/authoring/versions/${versionId}/tree`); setT(x); if (clear) setError(null);
      const [q, a, list] = await Promise.all([api.get<{ findings: QualityFinding[] }>(`/v1/ai/quality?versionId=${versionId}`).catch(() => ({ findings: [] })), api.get<A11yReport>(`/v1/authoring/versions/${versionId}/accessibility`).catch(() => null), api.get<ProgrammeRow[]>('/v1/authoring/programmes').catch(() => [] as ProgrammeRow[])]);
      setQuality(q.findings); setA11y(a); const older = list.find((p) => p.code === x.programme.code)?.versions.filter((v) => v.version < x.version)[0]; setPrev(older?.id ?? null);
    } catch (e) { setError(e); }
  }, [versionId]);
  useEffect(() => { setT(null); setIssues(null); setDone(null); void load(); }, [load]);
  /** Runs an action, then refreshes but keeps the error on screen (a refusal's reason is what the person needs to read). */
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); setDone(null); setIssues(null); try { await fn(); setDone(ok); await load(false); return true; } catch (e) { if (e instanceof ApiError && Array.isArray(e.body?.issues)) { setIssues(e.body.issues); setError(null); } else setError(e); await load(false); return false; } };
  if (!t) return <div><p><Link to="/staff/content">Back to content</Link></p><h1>Programme version</h1><ErrorNote error={error} />{!error && <Loading what="Loading the version" />}</div>;
  const canWrite = hasAny(roles, AREAS.content.act) && isDraft(t.state) && (t.authorId === meId || hasAny(roles, ['ACADEMIC_ADMIN']));
  const who = (id: string) => t.people[id] ?? 'Someone';
  const open = quality.filter((q) => q.blocking && !q.resolvedAt);
  return (
    <div>
      <p><Link to="/staff/content">Back to content</Link></p>
      <h1>{t.programme.title} <span className="muted">version {t.version}</span></h1>
      <p><Badge tone={stateTone(t.state)}>{stateLabel(t.state)}</Badge> <span className="muted">{t.programme.code} · {t.hours} h · {t.languages.map((l) => (l === 'hi' ? 'Hindi' : 'English')).join(' + ')} · written by {who(t.authorId)}</span>{typeof t.provenance?.source === 'string' && t.provenance.source !== 'manual' && <> <Badge tone="warn">AI-assisted</Badge></>}</p>
      <ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}
      <Workflow t={t} roles={roles} meId={meId} open={open.length} issues={issues} onMove={(to, reason) => act(() => api.post(`/v1/authoring/versions/${t.id}/transition`, { to, ...(reason ? { reason } : {}) }), `Moved to “${stateLabel(to)}”.`)} />
      {isDraft(t.state) && <Readiness t={t} a11y={a11y} />}
      {quality.length > 0 && <Quality findings={quality} canResolve={hasAny(roles, ['FACULTY_REVIEWER'])} onResolve={(id, r) => act(() => api.post(`/v1/ai/quality/${id}/resolve`, { resolution: r }), 'Finding resolved.')} />}
      {canWrite && hasAny(roles, AI_GEN) && <AiTopic t={t} />}
      {canWrite ? <Editor t={t} reload={() => load(false)} setDone={(m) => { setDone(m); setIssues(null); }} /> : <Content t={t} />}
      {prev && <Diff id={t.id} against={prev} />}
      <Comments t={t} who={who} onAdd={(body, target) => act(() => api.post(`/v1/authoring/versions/${t.id}/comments`, { body, ...(target ? { target } : {}) }), 'Comment added.')} />
      <Card title="Approval history">{!t.approvals.length ? <p className="muted">No moves yet.</p> : <ol>{t.approvals.map((a) => <li key={a.id}>{new Date(a.createdAt).toLocaleString()}: {who(a.actorId)} moved it from “{stateLabel(a.fromState)}” to “{stateLabel(a.toState)}”{a.reason ? ` — ${a.reason}` : ''}</li>)}</ol>}</Card>
    </div>
  );
}

function Workflow({ t, roles, meId, open, issues, onMove }: { t: VersionTree; roles: string[]; meId: string; open: number; issues: string[] | null; onMove: (to: string, reason?: string) => Promise<boolean> }) {
  const moves = movesFor(t.state, roles, meId, t); const [pick, setPick] = useState<string | null>(null); const [reason, setReason] = useState(''); const [problem, setProblem] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const m = moves.find((x) => x.to === pick);
  const go = async () => { if (m?.reasonRequired && !reason.trim()) { setProblem('Write the reason: it is recorded and shown to the author.'); return; } setBusy(true); const ok = await onMove(m!.to, reason.trim()); setBusy(false); if (ok) { setPick(null); setReason(''); } };
  return (
    <Card title="Where this stands">
      <p>{waitingOn(t.state) ? `Waiting on: ${waitingOn(t.state)}.` : t.state === 'PUBLISHED' ? 'Live for learners who are entitled to it. Published versions never change; make a new version to revise.' : 'Retired: no new learners start it.'}</p>
      {open > 0 && <p className="note error" role="alert">{open} unresolved quality finding{open === 1 ? '' : 's'} block approval. A reviewer must resolve or the author must fix them.</p>}
      {issues && <div role="alert" className="note error"><p>It is not ready for review yet:</p><ul>{issues.map((i) => <li key={i}>{i}</li>)}</ul></div>}
      {!moves.length ? <p className="muted">Your role has no move to make at this stage.</p> : (
        <div className="choices">{moves.map((x) => <button key={x.to} aria-pressed={pick === x.to} onClick={() => { setPick(x.to); setProblem(null); }} disabled={!!x.blocked}>{x.label}</button>)}</div>)}
      {moves.filter((x) => x.blocked).map((x) => <p key={x.to} className="muted">{x.label}: {x.blocked}</p>)}
      {m && (
        <form onSubmit={(e) => { e.preventDefault(); void go(); }} noValidate>
          {m.reasonRequired ? <><label htmlFor="wf-why">Reason (recorded and shown to the author)</label><textarea id="wf-why" value={reason} onChange={(e) => { setReason(e.target.value); setProblem(null); }} aria-invalid={!!problem} /></> : <p className="muted">{m.to === 'PUBLISHED' ? 'Publishing makes this version available to entitled learners and freezes it for good.' : 'You can add a note afterwards in the comments.'}</p>}
          {problem && <p role="alert" className="note error">{problem}</p>}
          <div className="choices"><button disabled={busy}>{busy ? 'Working…' : `Confirm: ${m.label}`}</button><button type="button" className="link" onClick={() => setPick(null)}>Cancel</button></div>
        </form>)}
    </Card>
  );
}

function Readiness({ t, a11y }: { t: VersionTree; a11y: A11yReport | null }) {
  const local = readinessIssues(t); const blocking = a11y?.issues.filter((i) => i.severity === 'BLOCKING') ?? []; const advisory = a11y?.issues.filter((i) => i.severity === 'ADVISORY') ?? [];
  return (
    <Card title="Ready for review?" actions={<Badge tone={local.length || (a11y?.enforced && blocking.length) ? 'warn' : 'ok'}>{local.length || (a11y?.enforced && blocking.length) ? 'Not yet' : 'Looks ready'}</Badge>}>
      {local.length ? <ul>{local.map((i) => <li key={i}>{i}</li>)}</ul> : <p>Every required video, quiz and assignment is in place and the hours add up.</p>}
      {a11y && (blocking.length > 0 || advisory.length > 0) && <>
        <h3>Accessibility {a11y.enforced ? '' : <span className="muted">(not enforced in this environment)</span>}</h3>
        <ul>{blocking.map((i, k) => <li key={`b${k}`}><strong>Must fix:</strong> {i.topic}: {i.message}</li>)}{advisory.map((i, k) => <li key={`a${k}`} className="muted">Worth adding: {i.topic}: {i.message}</li>)}</ul></>}
      <p className="muted">The server runs the complete check, including grading rules, when you send it for review, and lists anything it finds.</p>
    </Card>
  );
}

function Quality({ findings, canResolve, onResolve }: { findings: QualityFinding[]; canResolve: boolean; onResolve: (id: string, r: string) => Promise<boolean> }) {
  const [pick, setPick] = useState<string | null>(null); const [r, setR] = useState(''); const [problem, setProblem] = useState<string | null>(null);
  return (
    <Card title={`AI quality checks (${findings.filter((f) => !f.resolvedAt && f.blocking).length} blocking)`}>
      <ul className="plain">{findings.map((f) => (
        <li key={f.id} className="subcard"><p><Badge tone={f.blocking && !f.resolvedAt ? 'warn' : 'muted'}>{f.resolvedAt ? 'Resolved' : f.blocking ? 'Blocks approval' : f.severity.toLowerCase()}</Badge> <strong>{f.gate.replace(/_/g, ' ')}</strong>: {f.message}</p>
          {f.resolvedAt && <p className="muted">Resolution: {f.resolution}</p>}
          {canResolve && f.blocking && !f.resolvedAt && (pick === f.id ? (
            <form onSubmit={(e) => { e.preventDefault(); if (!r.trim()) { setProblem('Say why this can be accepted.'); return; } void onResolve(f.id, r.trim()).then((ok) => { if (ok) { setPick(null); setR(''); } }); }} noValidate>
              <label htmlFor={`qr-${f.id}`}>Why this can be accepted (recorded in the audit trail)</label><textarea id={`qr-${f.id}`} value={r} onChange={(e) => { setR(e.target.value); setProblem(null); }} />{problem && <p role="alert" className="note error">{problem}</p>}
              <div className="choices"><button>Resolve</button><button type="button" className="link" onClick={() => setPick(null)}>Cancel</button></div></form>) : <button onClick={() => { setPick(f.id); setProblem(null); }}>Resolve…</button>)}
        </li>))}</ul>
    </Card>
  );
}

/** The version as a reviewer needs to read it: every component, with the quiz answers. */
function Content({ t }: { t: VersionTree }) {
  return (
    <Card title="What is in this version">
      {t.outcomes.length > 0 && <><h3>Learning outcomes</h3><ul>{t.outcomes.map((o) => <li key={o}>{o}</li>)}</ul></>}
      {t.modules.map((m) => (
        <div key={m.id}><h3>Module {m.position}: {m.title}</h3>
          {m.topics.map((x) => { const s = topicStatus(x, t.languages); return (
            <details key={x.id} className="subcard"><summary><strong>{x.title}</strong> <span className="muted">{x.hours} h{x.mandatory ? '' : ' · optional'} · quiz {s.quiz} question{s.quiz === 1 ? '' : 's'} · {s.assignment ? 'assignment' : 'no assignment'} · {s.videos.map((v) => `${v.language === 'hi' ? 'Hindi' : 'English'} video ${v.ok ? '✓' : '✗'}`).join(', ')}</span></summary>
              {x.outcomes.length > 0 && <ul>{x.outcomes.map((o) => <li key={o}>{o}</li>)}</ul>}
              {x.assets.map((a) => <p key={a.id} className="muted">{a.language === 'hi' ? 'Hindi' : 'English'} {a.kind.toLowerCase()} · {a.durationSec ? `${Math.round(a.durationSec / 60)} min` : 'no length'} · files: {Object.keys(a.files).join(', ') || 'none'}{a.provenance && Object.keys(a.provenance).length ? ` · made by ${String((a.provenance as any).source ?? (a.provenance as any).model ?? 'unknown')}` : ''}</p>)}
              {x.quiz && <><h4>Quiz (pass {x.quiz.passPercent}%, {x.quiz.maxAttempts} attempts)</h4><ol>{x.quiz.questions.map((q) => <li key={q.id ?? q.position}>{q.text}{q.options.length > 0 && <ul>{q.options.map((o, i) => <li key={i}>{(Array.isArray(q.answer) ? q.answer.includes(i) : q.answer === i) ? <strong>✓ {o}</strong> : o}</li>)}</ul>}{q.type === 'NUMERIC' && <p>Answer: <strong>{String(q.answer)}</strong>{q.tolerance ? ` (± ${q.tolerance})` : ''}</p>}{q.rationale && <p className="muted">Why: {q.rationale}</p>}</li>)}</ol></>}
              {x.assignment && <><h4>Assignment (up to {x.assignment.maxSubmissions} submissions)</h4><p>{x.assignment.instructions}</p>{x.assignment.rubric.criteria && <ul>{x.assignment.rubric.criteria.map((c) => <li key={c.criterion}>{c.criterion} — {c.weight}%{c.description ? `: ${c.description}` : ''}</li>)}</ul>}</>}
            </details>); })}
        </div>))}
    </Card>
  );
}

function Diff({ id, against }: { id: string; against: string }) {
  const [open, setOpen] = useState(false); const [ch, setCh] = useState<DiffChange[] | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (open && !ch) api.get<{ changes: DiffChange[] }>(`/v1/authoring/versions/${id}/diff?against=${against}`).then((r) => setCh(r.changes)).catch(setError); }, [open, ch, id, against]);
  return (
    <Card title="Changes since the previous version">
      {!open ? <button onClick={() => setOpen(true)}>Show the changes</button> : <>{error ? <p role="alert" className="note error">{messageFor(error)}</p> : !ch ? <Loading /> : !ch.length ? <p>No structural changes (titles, hours, outcomes). Quiz and assignment wording is not compared.</p> : <ul>{ch.map((c, i) => <li key={i}>{describeChange(c)}</li>)}</ul>}</>}
    </Card>
  );
}

function Comments({ t, who, onAdd }: { t: VersionTree; who: (id: string) => string; onAdd: (body: string, target?: string) => Promise<boolean> }) {
  const [body, setBody] = useState(''); const [target, setTarget] = useState(''); const [problem, setProblem] = useState<string | null>(null);
  return (
    <Card title={`Review comments (${t.comments.length})`}>
      {!!t.comments.length && <ul className="plain">{t.comments.map((c) => <li key={c.id} className="subcard"><p><strong>{who(c.authorId)}</strong> <span className="muted">{new Date(c.createdAt).toLocaleString()}{c.target ? ` · on ${c.target}` : ''}</span></p><p>{c.body}</p></li>)}</ul>}
      <form onSubmit={(e) => { e.preventDefault(); if (!body.trim()) { setProblem('Write a comment first.'); return; } void onAdd(body.trim(), target || undefined).then((ok) => { if (ok) { setBody(''); setTarget(''); } }); }} noValidate>
        <label htmlFor="cm-on">About</label><select id="cm-on" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">The whole version</option>{t.modules.flatMap((m) => m.topics.map((x) => <option key={x.id} value={`${m.title} / ${x.title}`}>{m.title} / {x.title}</option>))}</select>
        <label htmlFor="cm-body">Comment</label><textarea id="cm-body" value={body} onChange={(e) => { setBody(e.target.value); setProblem(null); }} aria-invalid={!!problem} />{problem && <p role="alert" className="note error">{problem}</p>}
        <button>Add comment</button>
      </form>
    </Card>
  );
}

/** Ask the AI to (re)write one topic of this draft: its lesson script, quiz and assignment. Replaces what is in that topic; the result is a draft you still review. */
function AiTopic({ t }: { t: VersionTree }) {
  const nav = useNavigate(); const topics = t.modules.flatMap((m) => m.topics.map((x) => ({ id: x.id, label: `${m.title} › ${x.title}` })));
  const [topicId, setTopicId] = useState(''); const [instruction, setInstruction] = useState(''); const [langs, setLangs] = useState<string[]>(t.languages); const [ref, setRef] = useState('');
  const [problem, setProblem] = useState<string | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [jobs, setJobs] = useState<AiJob[]>([]);
  useEffect(() => { api.get<AiJob[]>('/v1/ai/jobs').then((all) => setJobs(all.filter((j) => j.versionId === t.id).slice(0, 5))).catch(() => undefined); }, [t.id]);
  const go = async () => {
    const p = topicProblem(topicId, langs, ref); setProblem(p); if (p) return; setBusy(true); setError(null);
    try { const r = await api.post<{ jobId: string }>('/v1/ai/topic-jobs', topicBody(topicId, instruction, langs, ref)); nav(`/staff/content/jobs/${r.jobId}`); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Card title="Write a topic with AI">
      <p className="muted">Pick a topic and the AI writes its lesson script, quiz and assignment <strong>into this draft</strong>, replacing what that topic has now. It stays a draft: you check it, resolve any quality flags, and it goes through review like your own work.</p>
      <form onSubmit={(e) => { e.preventDefault(); void go(); }} noValidate>
        <label htmlFor="at-topic">Topic</label><select id="at-topic" value={topicId} onChange={(e) => { setTopicId(e.target.value); setProblem(null); }}><option value="">Choose a topic</option>{topics.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
        <label htmlFor="at-ins">What should it cover? (optional)</label><textarea id="at-ins" rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Focus on thermistors; use a worked example with a numeric quiz question." />
        <fieldset><legend>Languages</legend>{[['en', 'English'], ['hi', 'Hindi']].filter(([k]) => t.languages.includes(k)).map(([k, l]) => <label key={k} className="inline"><input type="checkbox" checked={langs.includes(k)} onChange={(e) => { setLangs(e.target.checked ? [...langs, k] : langs.filter((x) => x !== k)); setProblem(null); }} /> {l}</label>)}</fieldset>
        <details><summary>Reference material (optional)</summary><label htmlFor="at-ref">Paste the text the AI must stay faithful to</label><textarea id="at-ref" rows={6} value={ref} onChange={(e) => setRef(e.target.value)} /></details>
        {problem && <p role="alert" className="note error">{problem}</p>}<ErrorNote error={error} />
        <button disabled={busy}>{busy ? 'Sending…' : 'Write this topic'}</button>
      </form>
      {jobs.length > 0 && <><h3>Recent AI jobs for this draft</h3><ul className="plain">{jobs.map((j) => <li key={j.id}><Link to={`/staff/content/jobs/${j.id}`}>{new Date(j.createdAt).toLocaleString()}</Link> · {kindLabel(j.kind)} <Badge tone={jobTone(j.status)}>{jobLabel(j.status)}</Badge></li>)}</ul></>}
    </Card>
  );
}
