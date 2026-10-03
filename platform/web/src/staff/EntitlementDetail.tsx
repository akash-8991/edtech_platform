import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { EntitlementDetailData, VersionOutline } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { extendProblem, historyLabel, OVERRIDE_TYPES, overrideLabel, overrideProblem, statusLabel, STATUS_TONE } from '../lib/entitlements';
import { canSee, ENTITLEMENTS, hasAny } from '../lib/roles';

export default function EntitlementDetail() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'entitlements')) return <Navigate to="/staff" replace />;
  return <Page roles={me!.roles} />;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function Page({ roles }: { roles: string[] }) {
  const { entitlementId = '' } = useParams(); const [e, setE] = useState<EntitlementDetailData | null>(null); const [outline, setOutline] = useState<VersionOutline | null>(null); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState<string | null>(null);
  const load = useCallback(async (clear = true) => { try { const d = await api.get<EntitlementDetailData>(`/v1/admin/entitlements/${entitlementId}`); setE(d); if (clear) setError(null); } catch (x) { setError(x); } }, [entitlementId]);
  useEffect(() => { setE(null); setDone(null); void load(); }, [load]);
  useEffect(() => { if (e && hasAny(roles, ENTITLEMENTS.override) && !outline) api.get<VersionOutline>(`/v1/catalogue/versions/${e.versionId}`).then(setOutline).catch(() => undefined); }, [e?.versionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); setDone(null); try { await fn(); setDone(ok); await load(false); return true; } catch (x) { setError(x); await load(false); return false; } };
  const note = useRef<HTMLDivElement>(null); useEffect(() => { if (done || error) note.current?.scrollIntoView?.({ block: 'nearest' }); }, [done, error]);
  if (!e) return <div><p><Link to="/staff/entitlements">Back to entitlements</Link></p><h1>Entitlement</h1><ErrorNote error={error} />{!error && <Loading what="Loading the entitlement" />}</div>;
  const live = e.status === 'ACTIVE' || e.status === 'PAUSED'; const topicName = (id: string) => outline?.modules.flatMap((m) => m.topics).find((t) => t.id === id)?.title ?? id.slice(0, 8);
  return (
    <div>
      <p><Link to="/staff/entitlements">Back to entitlements</Link></p>
      <h1>{e.learner.name}</h1>
      <p><Badge tone={STATUS_TONE(e.effectiveStatus)}>{statusLabel(e.effectiveStatus)}</Badge> {e.learningAccess ? <Badge tone="ok">Can learn now</Badge> : <Badge tone="warn">No access</Badge>} <span className="muted">{e.learner.email} · {e.programme.code} v{e.versionNumber} · {e.programme.title}</span></p>
      <div ref={note}><ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}</div>
      <Card title="Dates"><ul className="plain"><li>Starts: {when(e.startAt)}</li><li>Ends: {when(e.endAt)}</li><li>Cohort: {e.cohort} · {e.duration}</li><li>Pauses: {e.pauseCount} ({e.pausedDays} days){e.pausedAt ? ` · paused since ${when(e.pausedAt)}` : ''}</li></ul>
        <p className="muted">Pausing never moves the end date. Only an extension does.</p></Card>
      {hasAny(roles, ENTITLEMENTS.pause) && live && (e.status === 'PAUSED'
        ? <Reasoned title="Resume" help="Learning starts again. The end date stays where it is." button="Resume" optional onGo={() => act(() => api.post(`/v1/entitlements/${e.id}/resume`), 'Resumed.')} />
        : <Reasoned title="Pause" help="Stops access on the learner's behalf, for example for an agreed break. The end date does not move." button="Pause" optional onGo={(r) => act(() => api.post(`/v1/entitlements/${e.id}/pause`, { reason: r || undefined }), 'Paused.')} />)}
      {hasAny(roles, ENTITLEMENTS.extend) && live && <Extend onGo={(days, reason) => act(() => api.post(`/v1/entitlements/${e.id}/exceptions`, { extendDays: days, reason }), `Extended by ${days} days.`)} />}
      {hasAny(roles, ENTITLEMENTS.override) && live && <Override outline={outline} onGo={(b) => act(() => api.post(`/v1/entitlements/${e.id}/progression-overrides`, b), 'Saved. The learner has been told.')} />}
      {hasAny(roles, ENTITLEMENTS.revoke) && live && <Reasoned title="Revoke" danger help="Ends access for good and removes offline copies from their devices. This cannot be undone here." button="Revoke access" onGo={(r) => act(() => api.post(`/v1/entitlements/${e.id}/revoke`, { reason: r }), 'Revoked.')} />}
      <Card title="Pauses">{!e.pauses.length ? <p>None.</p> : <ul>{e.pauses.map((p) => <li key={p.id}>{when(p.startedAt)} to {p.endedAt ? when(p.endedAt) : 'now'}{p.reason ? ` — ${p.reason}` : ''}</li>)}</ul>}</Card>
      <Card title="Extensions and unlocks">{!e.exceptions.length && !e.overrides.length ? <p>None.</p> : <ul>{e.exceptions.map((x) => <li key={x.id}>{when(x.createdAt)}: extended by {x.extendDays} days — {x.reason}</li>)}{e.overrides.map((o) => <li key={o.id}>{when(o.createdAt)}: {overrideLabel(o.type)} on “{topicName(o.topicId)}”{o.value ? ` (${o.value})` : ''} — {o.reason}</li>)}</ul>}</Card>
      <Card title="History"><p className="muted">The last 50 changes to this entitlement.</p>{!e.history.length ? <p>Nothing recorded.</p> : <div className="scroll"><table><thead><tr><th>When</th><th>What</th><th>Role</th><th>Reason</th></tr></thead><tbody>{e.history.map((h) => <tr key={h.seq}><td>{when(h.createdAt)}</td><td>{historyLabel(h.action)}</td><td>{h.actorRole ?? 'system'}</td><td>{h.reason ?? ''}</td></tr>)}</tbody></table></div>}</Card>
    </div>
  );
}

/** A small form: one reason, one button. `optional` means the reason may be left empty. */
function Reasoned({ title, help, button, danger, optional, onGo }: { title: string; help: string; button: string; danger?: boolean; optional?: boolean; onGo: (reason: string) => Promise<unknown> }) {
  const [reason, setReason] = useState(''); const [problem, setProblem] = useState<string | null>(null); const [busy, setBusy] = useState(false); const id = `r-${title.toLowerCase().replace(/\W+/g, '-')}`;
  const go = async () => { if (!optional && !reason.trim()) { setProblem('Write the reason: it is recorded in the audit trail.'); return; } setBusy(true); try { if (await onGo(reason.trim())) setReason(''); } finally { setBusy(false); } };
  return (
    <Card title={title}><p className="muted">{help}</p>
      <label htmlFor={id}>Reason{optional ? ' (optional)' : ''}</label><input id={id} value={reason} onChange={(x) => { setReason(x.target.value); setProblem(null); }} maxLength={500} />
      {problem && <p role="alert" className="note error">{problem}</p>}
      <button className={danger ? 'secondary' : undefined} disabled={busy} onClick={() => void go()}>{busy ? 'Working…' : button}</button>
    </Card>
  );
}

function Extend({ onGo }: { onGo: (days: number, reason: string) => Promise<boolean> }) {
  const [days, setDays] = useState('30'); const [reason, setReason] = useState(''); const [problem, setProblem] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const go = async () => { const p = extendProblem(days, reason); setProblem(p); if (p) return; setBusy(true); try { if (await onGo(Number(days), reason.trim())) setReason(''); } finally { setBusy(false); } };
  return (
    <Card title="Extend the end date"><p className="muted">Adds days to the end date, for example after a long illness. This is the only way the end date moves.</p>
      <label htmlFor="ex-d">Days to add</label><input id="ex-d" inputMode="numeric" value={days} onChange={(x) => { setDays(x.target.value); setProblem(null); }} />
      <label htmlFor="ex-r">Reason</label><input id="ex-r" value={reason} onChange={(x) => { setReason(x.target.value); setProblem(null); }} maxLength={500} />
      {problem && <p role="alert" className="note error">{problem}</p>}<button disabled={busy} onClick={() => void go()}>{busy ? 'Saving…' : 'Extend'}</button>
    </Card>
  );
}

function Override({ outline, onGo }: { outline: VersionOutline | null; onGo: (b: { topicId: string; type: string; value?: number; reason: string }) => Promise<boolean> }) {
  const [type, setType] = useState('UNLOCK_TOPIC'); const [topicId, setTopicId] = useState(''); const [value, setValue] = useState('1'); const [reason, setReason] = useState(''); const [problem, setProblem] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const go = async () => { const p = overrideProblem(type, topicId, value, reason); setProblem(p); if (p) return; setBusy(true); try { if (await onGo({ topicId, type, reason: reason.trim(), ...(type !== 'UNLOCK_TOPIC' && { value: Number(value) }) })) setReason(''); } finally { setBusy(false); } };
  return (
    <Card title="Unlock or extend a topic"><p className="muted">{OVERRIDE_TYPES.find(([k]) => k === type)![2]}</p>
      {!outline ? <Loading what="Loading topics" /> : <>
        <label htmlFor="ov-t">What do you want to do</label><select id="ov-t" value={type} onChange={(x) => { setType(x.target.value); setProblem(null); }}>{OVERRIDE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <label htmlFor="ov-p">Topic</label><select id="ov-p" value={topicId} onChange={(x) => { setTopicId(x.target.value); setProblem(null); }}><option value="">Choose a topic</option>{outline.modules.map((m) => <optgroup key={m.id} label={m.title}>{m.topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</optgroup>)}</select>
        {type !== 'UNLOCK_TOPIC' && <><label htmlFor="ov-v">{type === 'EXTRA_QUIZ_ATTEMPTS' ? 'Extra attempts (1 to 5)' : 'Hours to add (1 to 720)'}</label><input id="ov-v" inputMode="numeric" value={value} onChange={(x) => { setValue(x.target.value); setProblem(null); }} /></>}
        <label htmlFor="ov-r">Reason</label><input id="ov-r" value={reason} onChange={(x) => { setReason(x.target.value); setProblem(null); }} maxLength={500} />
        {problem && <p role="alert" className="note error">{problem}</p>}<button disabled={busy} onClick={() => void go()}>{busy ? 'Saving…' : 'Save'}</button></>}
    </Card>
  );
}
