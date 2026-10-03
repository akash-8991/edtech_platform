import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api, messageFor } from '../api/client';
import type { DoubtDetail, TeacherRow } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { canReply, categoryLabel, describeContext, isOpen, langName, priorityTone, reasonError, resolveBlock, slaInfo, statusLabel, validateFaq } from '../lib/doubts';
import { DOUBTS, hasAny } from '../lib/roles';

export default function DoubtTicket() {
  const { me } = useAuth();
  if (!hasAny(me?.roles, DOUBTS.tickets)) return <Navigate to="/staff/doubts" replace />; // checked before anything is fetched
  return <Ticket roles={me!.roles} meId={me!.id} />;
}

function Ticket({ roles, meId }: { roles: string[]; meId: string }) {
  const { ticketId = '' } = useParams(); const isTeacher = hasAny(roles, DOUBTS.teacher); const isStaff = hasAny(roles, DOUBTS.staff);
  const [t, setT] = useState<DoubtDetail | null>(null); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState<string | null>(null);
  const load = useCallback(async (clear = true) => { try { setT(await api.get<DoubtDetail>(`/v1/teacher/tickets/${ticketId}`)); if (clear) setError(null); } catch (e) { setError(e); } }, [ticketId]);
  useEffect(() => { setT(null); setDone(null); void load(); }, [load]);
  /** Runs an action, then refreshes but keeps the error on screen (a refusal's reason is what the person needs to read). */
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); setDone(null); try { await fn(); setDone(ok); await load(false); return true; } catch (e) { setError(e); await load(false); return false; } };
  if (!t) return <div><p><Link to="/staff/doubts">Back to the doubt desk</Link></p><h1>Ticket</h1><ErrorNote error={error} />{!error && <Loading what="Loading the ticket" />}</div>;
  const sla = slaInfo(t); const ctx = describeContext(t.context); const mine = t.assignedTeacherId === meId; const open = isOpen(t.status);
  const block = resolveBlock(t);
  return (
    <div>
      <p><Link to="/staff/doubts">Back to the doubt desk</Link></p>
      <h1>#{t.number} {t.subject}</h1>
      <p><Badge tone={priorityTone(t.priority)}>{t.priority}</Badge> <Badge tone="muted">{statusLabel(t.status)}</Badge> <Badge tone={sla.tone}>{sla.text}</Badge> <span className="muted">{categoryLabel(t.category)} · {langName(t.language)} · asked by {t.learner?.name?.split(' ')[0] ?? 'a learner'} · {new Date(t.createdAt).toLocaleString()}</span></p>
      <p className="muted">{t.assignedTeacherId ? `With ${t.assignedTeacherName ?? (mine ? 'you' : 'a teacher')}.` : 'Not assigned yet.'}{t.routingNote ? ` (${t.routingNote})` : ''}{t.reopenCount ? ` Reopened ${t.reopenCount}×.` : ''}</p>
      <ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}
      {isTeacher && !t.assignedTeacherId && open && <p><button onClick={() => void act(() => api.post(`/v1/teacher/tickets/${t.id}/claim`), 'Yours now.')}>Take this ticket</button> <span className="muted">You can take it if its subject and language suit you and you have room.</span></p>}
      <Card title="What the learner was doing">
        <ul>{ctx.course && <li>Course: {ctx.course}</li>}{ctx.topic && <li>Topic: {ctx.topic}</li>}{ctx.progress && <li>Progress: {ctx.progress}</li>}{!ctx.course && !ctx.topic && !ctx.progress && <li className="muted">Nothing was recorded.</li>}</ul>
        {ctx.conversation.length > 0 && <details><summary>Earlier chat with the AI tutor ({ctx.conversation.length} messages{ctx.sources ? `, ${ctx.sources} sources searched` : ''})</summary><ul>{ctx.conversation.map((m, i) => <li key={i}><strong>{m.who}:</strong> {m.text}</li>)}</ul></details>}
      </Card>
      <Card title="Conversation"><Thread t={t} /></Card>
      {canReply(t) && (mine || isStaff) && <Reply onSend={(body, internal) => act(() => api.post(`/v1/teacher/tickets/${t.id}/reply`, { body, internal }), internal ? 'Note saved. The learner cannot see it.' : 'Reply sent. The learner has been told.')} />}
      {open && t.assignedTeacherId && (mine || isStaff) && <Resolve block={block} onResolve={(s) => act(() => api.post(`/v1/teacher/tickets/${t.id}/resolve`, { summary: s }), 'Resolved. The learner can reopen it for 7 days.')} />}
      {!open && <Card title="Outcome"><p>{t.resolutionSummary ?? 'Closed.'}</p>{t.rating !== null && <p className="muted">The learner rated it {t.rating} out of 5.</p>}</Card>}
      {t.appointments.length > 0 && <Appts t={t} canConfirm={mine && isTeacher} onConfirm={(id, ref) => act(() => api.post(`/v1/teacher/appointments/${id}/confirm`, ref ? { meetingRef: ref } : {}), 'Appointment confirmed.')} onCancel={(id) => act(() => api.post(`/v1/appointments/${id}/cancel`), 'Appointment cancelled.')} />}
      {isTeacher && mine && <ProposeFaq t={t} onSend={(b) => act(() => api.post(`/v1/teacher/tickets/${t.id}/propose-faq`, b), 'Proposed. A reviewer will look at it before anyone else sees it.')} />}
      {isStaff && open && <Reassign t={t} onGo={(teacherId, reason) => act(() => api.post(`/v1/doubt-centre/tickets/${t.id}/reassign`, { reason, ...(teacherId ? { teacherId } : {}) }), 'Reassigned.')} />}
    </div>
  );
}

function Thread({ t }: { t: DoubtDetail }) {
  const [err, setErr] = useState<string | null>(null);
  const get = async (key: string, name: string) => { setErr(null); try { const b = await api.download(`/v1/teacher/tickets/${t.id}/attachment?key=${encodeURIComponent(key)}`); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u); } catch (e) { setErr(messageFor(e)); } };
  return (
    <>
      <ul className="plain">{t.messages.map((m) => (
        <li key={m.id} className={`subcard${m.internal ? ' internal' : ''}`}><p><strong>{m.authorRole === 'LEARNER' ? t.learner?.name?.split(' ')[0] ?? 'Learner' : m.authorRole === 'TEACHER' ? 'Teacher' : 'System'}</strong>{m.internal && <> <Badge tone="warn">Internal note: the learner cannot see this</Badge></>} <span className="muted">{new Date(m.at).toLocaleString()}</span></p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{m.body}</p>
          {m.attachments.map((a) => <p key={a.key}><button className="link" onClick={() => void get(a.key, a.name ?? 'attachment')}>Download {a.name ?? 'attachment'}</button>{a.size ? <span className="muted"> ({Math.max(1, Math.round(a.size / 1024))} KB)</span> : null}</p>)}
        </li>))}</ul>
      {err && <p role="alert" className="note error">{err}</p>}
    </>
  );
}

function Reply({ onSend }: { onSend: (body: string, internal: boolean) => Promise<boolean> }) {
  const [body, setBody] = useState(''); const [internal, setInternal] = useState(false); const [problem, setProblem] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  return (
    <Card title="Reply">
      <form onSubmit={(e) => { e.preventDefault(); if (!body.trim()) { setProblem('Write your reply first.'); return; } setBusy(true); void onSend(body.trim(), internal).then((ok) => { setBusy(false); if (ok) setBody(''); }); }} noValidate>
        <label htmlFor="rp-body">Your reply</label><textarea id="rp-body" value={body} onChange={(e) => { setBody(e.target.value); setProblem(null); }} aria-invalid={!!problem} />
        <label className="inline"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note (only staff see it; the learner is not told)</label>
        {problem && <p role="alert" className="note error">{problem}</p>}
        <p><button disabled={busy}>{busy ? 'Sending…' : internal ? 'Save note' : 'Send reply'}</button></p>
      </form>
    </Card>
  );
}

function Resolve({ block, onResolve }: { block: string | null; onResolve: (s: string) => Promise<boolean> }) {
  const [s, setS] = useState(''); const [problem, setProblem] = useState<string | null>(null);
  return (
    <Card title="Resolve">
      {block ? <p className="muted">{block}</p> : <form onSubmit={(e) => { e.preventDefault(); if (!s.trim()) { setProblem('Write a short summary of the answer: the learner sees it.'); return; } void onResolve(s.trim()); }} noValidate>
        <label htmlFor="rs-sum">Summary of the answer (the learner sees this)</label><textarea id="rs-sum" value={s} onChange={(e) => { setS(e.target.value); setProblem(null); }} aria-invalid={!!problem} />{problem && <p role="alert" className="note error">{problem}</p>}
        <button>Mark as resolved</button></form>}
    </Card>
  );
}

function Appts({ t, canConfirm, onConfirm, onCancel }: { t: DoubtDetail; canConfirm: boolean; onConfirm: (id: string, ref: string) => Promise<boolean>; onCancel: (id: string) => Promise<boolean> }) {
  const [ref, setRef] = useState('');
  return (
    <Card title="Appointments"><ul className="plain">{t.appointments.map((a) => (
      <li key={a.id} className="subcard"><p>{new Date(a.startsAt).toLocaleString()} <Badge tone={a.status === 'CONFIRMED' ? 'ok' : 'muted'}>{a.status.toLowerCase()}</Badge>{a.meetingRef ? <span className="muted"> · {a.meetingRef}</span> : null}</p>
        {(a.status === 'REQUESTED' || a.status === 'CONFIRMED') && <div className="choices">{canConfirm && a.status === 'REQUESTED' && <><label htmlFor={`ar-${a.id}`}>Meeting link or room (optional)</label><input id={`ar-${a.id}`} value={ref} onChange={(e) => setRef(e.target.value)} /><button onClick={() => void onConfirm(a.id, ref.trim())}>Confirm</button></>}<button className="link" onClick={() => { if (window.confirm('Cancel this appointment? The learner is told.')) void onCancel(a.id); }}>Cancel appointment</button></div>}
      </li>))}</ul></Card>
  );
}

function ProposeFaq({ t, onSend }: { t: DoubtDetail; onSend: (b: object) => Promise<boolean> }) {
  const [open, setOpen] = useState(false); const [f, setF] = useState({ question: '', answer: '', language: t.language, kind: 'FAQ', topic: !!t.topicId }); const [problem, setProblem] = useState<string | null>(null);
  if (!open) return <p><button onClick={() => setOpen(true)}>Suggest this as a reusable answer</button></p>;
  return (
    <Card title="Suggest a reusable answer">
      <form onSubmit={(e) => { e.preventDefault(); const p = validateFaq(f); setProblem(p); if (!p) void onSend({ question: f.question.trim(), answer: f.answer.trim(), language: f.language, kind: f.kind, ...(f.topic && t.topicId ? { topicId: t.topicId } : {}) }).then((ok) => ok && setOpen(false)); }} noValidate>
        <p className="muted">Names, emails and phone numbers are removed automatically, but check your wording too. A reviewer approves it before the AI tutor or any learner sees it.</p>
        <label htmlFor="pf-q">Question, as a learner would ask it</label><textarea id="pf-q" value={f.question} onChange={(e) => { setF({ ...f, question: e.target.value }); setProblem(null); }} />
        <label htmlFor="pf-a">Answer</label><textarea id="pf-a" value={f.answer} onChange={(e) => { setF({ ...f, answer: e.target.value }); setProblem(null); }} />
        <label htmlFor="pf-k">Where it is used</label><select id="pf-k" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="FAQ">General FAQ for the programme</option><option value="REMEDIATION">Help shown on the topic page</option></select>
        <label htmlFor="pf-l">Language</label><select id="pf-l" value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}><option value="en">English</option><option value="hi">Hindi</option></select>
        {t.topicId && <label className="inline"><input type="checkbox" checked={f.topic} onChange={(e) => setF({ ...f, topic: e.target.checked })} /> Tie it to this ticket's topic</label>}
        {problem && <p role="alert" className="note error">{problem}</p>}
        <div className="choices"><button>Send for review</button><button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </Card>
  );
}

function Reassign({ t, onGo }: { t: DoubtDetail; onGo: (teacherId: string, reason: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false); const [teachers, setTeachers] = useState<TeacherRow[] | null>(null); const [pick, setPick] = useState(''); const [reason, setReason] = useState(''); const [problem, setProblem] = useState<string | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (open && !teachers) api.get<TeacherRow[]>('/v1/doubt-centre/teachers').then(setTeachers).catch(setError); }, [open, teachers]);
  if (!open) return <p><button onClick={() => setOpen(true)}>Reassign…</button></p>;
  return (
    <Card title="Reassign">
      <ErrorNote error={error} />
      <form onSubmit={(e) => { e.preventDefault(); const p = reasonError(reason); setProblem(p); if (!p) void onGo(pick, reason.trim()).then((ok) => ok && setOpen(false)); }} noValidate>
        <label htmlFor="ra-t">Give it to</label><select id="ra-t" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Pick the best available teacher automatically</option>{teachers?.filter((x) => x.active && x.userId !== t.assignedTeacherId).map((x) => <option key={x.userId} value={x.userId}>{x.name ?? 'Unnamed'} ({x.open} of {x.capacity} open{x.available ? '' : ', not taking tickets'})</option>)}</select>
        <label htmlFor="ra-r">Reason (recorded in the audit trail)</label><textarea id="ra-r" value={reason} onChange={(e) => { setReason(e.target.value); setProblem(null); }} aria-invalid={!!problem} />{problem && <p role="alert" className="note error">{problem}</p>}
        <div className="choices"><button>Reassign</button><button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </Card>
  );
}
