import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../api/client';
import type { CatalogueItem, LabActivityDef, RosterRow, StaffSlot } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { slotTime } from '../lib/labs';
import { canSee } from '../lib/roles';
import { checkinLink, localToIso, validateSlot, type SlotForm } from '../lib/staff';

export default function LabDesk() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'labs')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <LabDeskInner />;
}

function LabDeskInner() {
  const [versions, setVersions] = useState<CatalogueItem[] | null>(null); const [versionId, setVersionId] = useState(''); const [acts, setActs] = useState<LabActivityDef[]>([]); const [actId, setActId] = useState('');
  const [slots, setSlots] = useState<StaffSlot[] | null>(null); const [openSlot, setOpenSlot] = useState<StaffSlot | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.get<CatalogueItem[]>('/v1/catalogue').then((v) => { setVersions(v); if (v[0]) setVersionId(v[0].versionId); }).catch(setError); }, []);
  useEffect(() => { setActs([]); setActId(''); if (!versionId) return; api.get<LabActivityDef[]>(`/v1/authoring/versions/${versionId}/labs`).then((a) => { setActs(a); if (a[0]) setActId(a[0].id); }).catch(setError); }, [versionId]);
  const loadSlots = useCallback(async () => { if (!actId) { setSlots([]); return; } try { setSlots(await api.get<StaffSlot[]>(`/v1/labs/slots?activityId=${actId}&scope=all`)); } catch (e) { setError(e); } }, [actId]);
  useEffect(() => { setSlots(null); setOpenSlot(null); void loadSlots(); }, [loadSlots]);
  if (!versions) return <div><h1>Lab desk</h1>{error ? <ErrorNote error={error} /> : <Loading what="Loading" />}</div>;
  const act = acts.find((a) => a.id === actId);
  return (
    <div>
      <h1>Lab desk</h1>
      <ErrorNote error={error} />
      <Card title="Choose a lab">
        <label htmlFor="ld-ver">Programme version</label><select id="ld-ver" value={versionId} onChange={(e) => setVersionId(e.target.value)}>{versions.map((v) => <option key={v.versionId} value={v.versionId}>{v.title} ({v.code})</option>)}</select>
        {!acts.length ? <p className="muted">This version has no lab activities.</p> : (<><label htmlFor="ld-act">Lab</label><select id="ld-act" value={actId} onChange={(e) => setActId(e.target.value)}>{acts.map((a) => <option key={a.id} value={a.id}>{a.title} ({a.code})</option>)}</select></>)}
      </Card>
      {act && <NewSlot activity={act} onCreated={loadSlots} />}
      {act && (
        <Card title="Sessions">
          {!slots ? <Loading /> : !slots.length ? <p className="muted">No sessions in the last 30 days or planned. Create one above.</p> : (
            <ul className="plain">{slots.map((s) => (
              <li key={s.id} className="row session"><span><strong>{slotTime(s)}</strong>{s.location ? ` · ${s.location}` : ''} <span className="muted">· batch {s.batchCode} · {s.capacity - s.seatsLeft}/{s.capacity} booked</span></span>
                <span className="row">{s.status === 'CANCELLED' && <Badge tone="muted">Cancelled</Badge>}{s.status !== 'CANCELLED' && <button className="secondary" onClick={() => setOpenSlot(openSlot?.id === s.id ? null : s)}>{openSlot?.id === s.id ? 'Close' : 'Run this session'}</button>}</span></li>))}</ul>)}
        </Card>)}
      {openSlot && <SlotPanel key={openSlot.id} slot={openSlot} requireEvidence={act?.requireEvidence ?? true} onChanged={loadSlots} />}
    </div>
  );
}

function NewSlot({ activity, onCreated }: { activity: LabActivityDef; onCreated: () => Promise<void> }) {
  const empty: SlotForm = { batchCode: '', startsAt: '', endsAt: '', capacity: '20', location: activity.location ?? '' };
  const [f, setF] = useState<SlotForm>(empty); const [error, setError] = useState<unknown>(null); const [local, setLocal] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [ok, setOk] = useState(false);
  useEffect(() => setF({ ...empty, location: activity.location ?? '' }), [activity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof SlotForm) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async () => {
    const v = validateSlot(f); setLocal(v); setOk(false); if (v) return; setBusy(true); setError(null);
    try { await api.post('/v1/labs/slots', { activityId: activity.id, batchCode: f.batchCode.trim(), startsAt: localToIso(f.startsAt), endsAt: localToIso(f.endsAt), capacity: Number(f.capacity), ...(f.location.trim() && { location: f.location.trim() }) }); setF({ ...empty, location: f.location }); setOk(true); await onCreated(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Card title="Plan a new session">
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label="New session">
        <label htmlFor="ns-batch">Batch or cohort</label><input id="ns-batch" value={f.batchCode} onChange={set('batchCode')} />
        <label htmlFor="ns-start">Starts</label><input id="ns-start" type="datetime-local" value={f.startsAt} onChange={set('startsAt')} />
        <label htmlFor="ns-end">Ends</label><input id="ns-end" type="datetime-local" value={f.endsAt} onChange={set('endsAt')} />
        <label htmlFor="ns-cap">Seats</label><input id="ns-cap" type="number" min={1} max={500} value={f.capacity} onChange={set('capacity')} />
        <label htmlFor="ns-loc">Location</label><input id="ns-loc" value={f.location} onChange={set('location')} />
        {local && <p role="alert" className="note error">{local}</p>}<ErrorNote error={error} />{ok && <p role="status" className="note ok">Session created. Learners can book it now.</p>}
        <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create session'}</button>
      </form>
    </Card>
  );
}

function SlotPanel({ slot, requireEvidence, onChanged }: { slot: StaffSlot; requireEvidence: boolean; onChanged: () => Promise<void> }) {
  const [roster, setRoster] = useState<RosterRow[] | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<{ bookingId: string; kind: 'complete' } | { kind: 'cancel' } | null>(null); const [reason, setReason] = useState('');
  const load = useCallback(() => api.get<RosterRow[]>(`/v1/labs/slots/${slot.id}/roster`).then((r) => { setRoster(r); }).catch(setError), [slot.id]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 20_000); return () => clearInterval(t); }, [load]);
  const run = async (id: string, fn: () => Promise<unknown>) => { setBusy(id); setError(null); try { await fn(); await load(); await onChanged(); setReasonFor(null); setReason(''); } catch (e) { setError(e); } finally { setBusy(null); } };
  const live = (roster ?? []).filter((r) => r.status !== 'CANCELLED');
  return (
    <Card title={`Running: ${slotTime(slot)}`}>
      <CheckinCode slotId={slot.id} />
      <h3>Roster ({live.length})</h3>
      <ErrorNote error={error} />
      {!roster ? <Loading /> : !live.length ? <p className="muted">Nobody has booked this session yet.</p> : (
        <table className="grid"><caption className="sr-only">Roster</caption><thead><tr><th>Learner</th><th>Status</th>{requireEvidence && <th>Evidence</th>}<th>Actions</th></tr></thead>
          <tbody>{live.map((r) => (
            <tr key={r.bookingId}><td>{r.name ?? 'Learner'}</td><td><Badge tone={r.completed ? 'ok' : r.status === 'ATTENDED' ? 'ok' : r.status === 'NO_SHOW' ? 'muted' : 'warn'}>{r.completed ? 'completed' : r.status.toLowerCase().replace('_', ' ')}</Badge>{r.attendanceMethod ? <span className="muted"> ({r.attendanceMethod.toLowerCase()})</span> : null}</td>
              {requireEvidence && <td>{r.evidenceFiles ? `${r.evidenceFiles} file${r.evidenceFiles > 1 ? 's' : ''}` : '—'}</td>}
              <td><span className="row">
                {r.status === 'BOOKED' && <><button disabled={busy === r.bookingId} onClick={() => void run(r.bookingId, () => api.post(`/v1/labs/slots/${slot.id}/attendance`, { learnerId: r.learnerId, status: 'ATTENDED' }))}>Present</button><button className="secondary" disabled={busy === r.bookingId} onClick={() => void run(r.bookingId, () => api.post(`/v1/labs/slots/${slot.id}/attendance`, { learnerId: r.learnerId, status: 'NO_SHOW' }))}>No-show</button></>}
                {r.status === 'ATTENDED' && !r.completed && <button className="secondary" onClick={() => setReasonFor({ bookingId: r.bookingId, kind: 'complete' })}>Mark complete…</button>}</span></td></tr>))}</tbody></table>)}
      {reasonFor?.kind === 'complete' && (
        <form className="card inner" aria-label="Complete lab" onSubmit={(e) => { e.preventDefault(); void run(reasonFor.bookingId, () => api.post(`/v1/labs/bookings/${reasonFor.bookingId}/complete`, { reason: reason.trim() })); }}>
          <p>Completing a lab without the normal evidence is an exception and is recorded in the audit trail with your name and this reason.</p><label htmlFor="cr">Reason</label><input id="cr" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="choices"><button type="submit" disabled={!reason.trim() || busy !== null}>Confirm completion</button><button type="button" className="secondary" onClick={() => setReasonFor(null)}>Cancel</button></div></form>)}
      <h3>Cancel this session</h3>
      {reasonFor?.kind === 'cancel' ? (
        <form className="card inner" aria-label="Cancel session" onSubmit={(e) => { e.preventDefault(); void run('cancel', () => api.post(`/v1/labs/slots/${slot.id}/cancel`, { reason: reason.trim() })); }}>
          <p className="note warn" role="alert">Every learner booked on this session is cancelled and notified. This cannot be undone.</p><label htmlFor="cs">Reason (recorded)</label><input id="cs" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="choices"><button type="submit" disabled={!reason.trim() || busy !== null}>Cancel session and notify learners</button><button type="button" className="secondary" onClick={() => setReasonFor(null)}>Keep it</button></div></form>)
        : <button className="secondary" onClick={() => setReasonFor({ kind: 'cancel' })}>Cancel this session…</button>}
    </Card>
  );
}

/** The check-in code changes every 90 seconds (so a photo of it is useless later); this panel refreshes it before it expires and shows it as a QR code. */
export function CheckinCode({ slotId, refreshMs = 45_000 }: { slotId: string; refreshMs?: number }) {
  const [state, setState] = useState<{ token: string; link: string; qr: string | null; validUntil: number } | null>(null); const [error, setError] = useState<unknown>(null); const [left, setLeft] = useState(0); const [shown, setShown] = useState(true);
  useEffect(() => {
    let alive = true;
    const fetchCode = async () => {
      try { const r = await api.get<{ token: string; validSeconds: number }>(`/v1/labs/slots/${slotId}/qr`); const link = checkinLink(r.token); let qr: string | null = null; try { qr = await (await import('qrcode')).toDataURL(link, { margin: 1, width: 320 }); } catch { /* the text code still works */ }
        if (alive) { setState({ token: r.token, link, qr, validUntil: Date.now() + r.validSeconds * 1000 }); setError(null); } } catch (e) { if (alive) setError(e); }
    };
    void fetchCode(); const t = setInterval(() => void fetchCode(), refreshMs); return () => { alive = false; clearInterval(t); };
  }, [slotId, refreshMs]);
  useEffect(() => { const t = setInterval(() => setLeft(state ? Math.max(0, Math.round((state.validUntil - Date.now()) / 1000)) : 0), 500); return () => clearInterval(t); }, [state]);
  return (
    <div className="qrbox" aria-label="Check-in code">
      <h3>Check-in code</h3>
      <ErrorNote error={error} />
      {state ? (<>{shown && (state.qr ? <img src={state.qr} alt="QR code: learners scan this to check in" /> : <p className="mono bigcode">{state.token.slice(-12)}</p>)}
        <p className="muted" role="status">{left > 0 ? `Changes in ${left}s` : 'Refreshing…'}</p>
        <div className="choices"><button className="secondary" onClick={() => setShown((s) => !s)}>{shown ? 'Hide code' : 'Show code'}</button><button className="secondary" onClick={() => void navigator.clipboard?.writeText(state.link)}>Copy link</button></div></>) : !error && <Loading />}
      <p className="muted">Show this on the lab screen. Learners scan it with their phone camera; it opens the check-in page with the code filled in.</p>
    </div>
  );
}
