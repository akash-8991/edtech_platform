import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { DoubtAppointment, TeacherRow, TeacherWindow } from '../api/types';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { dayName, langName, splitList, validateTeacher, validateWindows, windowsText } from '../lib/doubts';

export function Teachers({ canRead, canEdit, isTeacher }: { canRead: boolean; canEdit: boolean; isTeacher: boolean }) {
  return <>{isTeacher && <MyAvailability />}{canRead && <Directory canEdit={canEdit} />}</>;
}

function WindowsEditor({ value, onChange }: { value: TeacherWindow[]; onChange: (w: TeacherWindow[]) => void }) {
  return (
    <fieldset><legend>Working periods (India time). Leave empty to be available at any time.</legend>
      {value.map((w, i) => (
        <div key={i} className="choices">
          <select aria-label={`Period ${i + 1} day`} value={w.day} onChange={(e) => onChange(value.map((x, k) => (k === i ? { ...x, day: Number(e.target.value) } : x)))} style={{ width: 'auto' }}>{[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{dayName(d)}</option>)}</select>
          <input type="time" aria-label={`Period ${i + 1} start`} value={w.start} onChange={(e) => onChange(value.map((x, k) => (k === i ? { ...x, start: e.target.value } : x)))} style={{ width: 'auto' }} /> to <input type="time" aria-label={`Period ${i + 1} end`} value={w.end} onChange={(e) => onChange(value.map((x, k) => (k === i ? { ...x, end: e.target.value } : x)))} style={{ width: 'auto' }} />
          <button type="button" className="link" onClick={() => onChange(value.filter((_, k) => k !== i))}>Remove period {i + 1}</button>
        </div>))}
      <button type="button" onClick={() => onChange([...value, { day: 1, start: '09:00', end: '17:00' }])}>Add a working period</button>
    </fieldset>
  );
}

function MyAvailability() {
  const [p, setP] = useState<TeacherRow | null>(null); const [avail, setAvail] = useState(true); const [ws, setWs] = useState<TeacherWindow[]>([]); const [error, setError] = useState<unknown>(null); const [problem, setProblem] = useState<string | null>(null); const [done, setDone] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<TeacherRow>('/v1/teacher/profile').then((x) => { setP(x); setAvail(x.available); setWs(x.windows ?? []); }).catch(setError); }, []);
  const save = async () => { const e = validateWindows(ws); setProblem(e); if (e) return; setBusy(true); setError(null); setDone(null); try { const x = await api.put<TeacherRow>('/v1/teacher/profile', { available: avail, windows: ws }); setP(x); setDone('Saved.'); } catch (er) { setError(er); } finally { setBusy(false); } };
  return (
    <Card title="My availability">
      <ErrorNote error={error} />{!p && !error && <Loading />}
      {p && <form onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
        <p className="muted">Your subjects, languages and how many tickets you can hold ({p.capacity}) are set by an administrator. You have {p.open} open now.</p>
        <label className="inline"><input type="checkbox" checked={avail} onChange={(e) => setAvail(e.target.checked)} /> I am available for new tickets</label>
        <WindowsEditor value={ws} onChange={(w) => { setWs(w); setProblem(null); }} />
        {problem && <p role="alert" className="note error">{problem}</p>}{done && <p role="status" className="note">{done}</p>}
        <button disabled={busy}>{busy ? 'Saving…' : 'Save availability'}</button></form>}
    </Card>
  );
}

function Directory({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<TeacherRow[] | null>(null); const [error, setError] = useState<unknown>(null); const [edit, setEdit] = useState<string | null>(null); const [done, setDone] = useState<string | null>(null);
  const load = useCallback(async () => { try { setRows(await api.get<TeacherRow[]>('/v1/doubt-centre/teachers')); setError(null); } catch (e) { setError(e); } }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async (userId: string, body: object) => { setError(null); setDone(null); try { await api.put(`/v1/doubt-centre/teachers/${userId}`, body); setEdit(null); setDone('Saved.'); await load(); return true; } catch (e) { setError(e); return false; } };
  return (
    <Card title="Teachers">
      <ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}
      {!rows ? (!error && <Loading />) : !rows.length ? <p>No teachers are registered yet.</p> : (
        <ul className="plain">{rows.map((t) => (
          <li key={t.userId} className="subcard"><p><strong>{t.name ?? 'Unnamed'}</strong> <Badge tone={t.active ? 'ok' : 'muted'}>{t.active ? 'Active' : 'Not active'}</Badge> {t.active && <Badge tone={t.available ? 'ok' : 'muted'}>{t.available ? 'Available' : 'Not taking tickets'}</Badge>}</p>
            <p className="muted">{t.open} of {t.capacity} tickets open · {t.disciplines.join(', ') || 'no subjects'} · {t.languages.map(langName).join(', ')} · {windowsText(t.windows)}{t.skills.length ? ` · skills: ${t.skills.join(', ')}` : ''}</p>
            {canEdit && (edit === t.userId ? <TeacherForm t={t} onSave={(b) => save(t.userId, b)} onCancel={() => setEdit(null)} /> : <button onClick={() => { setEdit(t.userId); setDone(null); }}>Edit {t.name ?? 'teacher'}</button>)}
          </li>))}</ul>)}
      {canEdit && <Register existing={(rows ?? []).map((t) => t.userId)} onSave={(id) => save(id, { active: true })} />}
    </Card>
  );
}

function TeacherForm({ t, onSave, onCancel }: { t: TeacherRow; onSave: (b: object) => Promise<boolean>; onCancel: () => void }) {
  const [disc, setDisc] = useState(t.disciplines.join(', ')); const [skills, setSkills] = useState(t.skills.join(', ')); const [langs, setLangs] = useState(t.languages); const [cap, setCap] = useState(String(t.capacity)); const [active, setActive] = useState(t.active); const [avail, setAvail] = useState(t.available); const [ws, setWs] = useState(t.windows ?? []);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form onSubmit={(e) => { e.preventDefault(); const p = validateTeacher({ capacity: cap, languages: langs, windows: ws }); setProblem(p); if (!p) void onSave({ disciplines: splitList(disc), skills: splitList(skills), languages: langs, capacity: Number(cap), active, available: avail, windows: ws }); }} noValidate>
      <label htmlFor={`td-${t.userId}`}>Subjects they can answer (comma separated, must match a programme's discipline)</label><input id={`td-${t.userId}`} value={disc} onChange={(e) => setDisc(e.target.value)} />
      <label htmlFor={`ts-${t.userId}`}>Skills (comma separated)</label><input id={`ts-${t.userId}`} value={skills} onChange={(e) => setSkills(e.target.value)} />
      <fieldset><legend>Languages</legend>{['en', 'hi'].map((l) => <label key={l} className="inline"><input type="checkbox" checked={langs.includes(l)} onChange={(e) => { setLangs(e.target.checked ? [...langs, l] : langs.filter((x) => x !== l)); setProblem(null); }} /> {langName(l)}</label>)}</fieldset>
      <label htmlFor={`tc-${t.userId}`}>Open tickets at once</label><input id={`tc-${t.userId}`} inputMode="numeric" value={cap} onChange={(e) => { setCap(e.target.value); setProblem(null); }} style={{ width: '6rem' }} />
      <label className="inline"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active teacher</label> <label className="inline"><input type="checkbox" checked={avail} onChange={(e) => setAvail(e.target.checked)} /> Taking new tickets</label>
      <WindowsEditor value={ws} onChange={(w) => { setWs(w); setProblem(null); }} />
      {problem && <p role="alert" className="note error">{problem}</p>}
      <div className="choices"><button>Save</button><button type="button" className="link" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

/** Picks from people who already hold the Doubt Teacher role but are not registered at the desk yet. */
function Register({ existing, onSave }: { existing: string[]; onSave: (id: string) => Promise<boolean> }) {
  const [cands, setCands] = useState<{ id: string; name: string; email?: string }[] | null>(null); const [pick, setPick] = useState(''); const [problem, setProblem] = useState<string | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.get<{ id: string; name: string; email?: string; status: string }[]>('/v1/admin/users?role=DOUBT_TEACHER&status=ACTIVE&limit=200').then((r) => setCands(r.filter((x) => !existing.includes(x.id)))).catch(setError); }, [existing.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!pick) { setProblem('Choose a person.'); return; } void onSave(pick).then((ok) => ok && setPick('')); }} noValidate className="subcard">
      <h3>Register a teacher</h3><ErrorNote error={error} />
      {!cands ? (!error && <Loading />) : !cands.length ? <p className="muted">Everyone who holds the Doubt Teacher role is already registered. To add someone new, give them the Doubt Teacher role first (People → their record → Roles).</p> : <>
        <label htmlFor="rg-id">Person</label><select id="rg-id" value={pick} onChange={(e) => { setPick(e.target.value); setProblem(null); }}><option value="">Choose…</option>{cands.map((c) => <option key={c.id} value={c.id}>{c.name}{c.email ? ` (${c.email})` : ''}</option>)}</select>
        {problem && <p role="alert" className="note error">{problem}</p>}<button>Register</button><p className="muted">Then edit them to set subjects and languages.</p></>}
    </form>
  );
}

export function Appointments() {
  const [rows, setRows] = useState<DoubtAppointment[] | null>(null); const [error, setError] = useState<unknown>(null); const [ref, setRef] = useState<Record<string, string>>({}); const [done, setDone] = useState<string | null>(null);
  const load = useCallback(async (clear = true) => { try { setRows(await api.get<DoubtAppointment[]>('/v1/teacher/appointments')); if (clear) setError(null); } catch (e) { setError(e); } }, []);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); setDone(null); try { await fn(); setDone(ok); await load(false); } catch (e) { setError(e); await load(false); } };
  return (
    <>
      <ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}
      {!rows ? (!error && <Loading />) : !rows.length ? <Card><p>No appointments are waiting or booked.</p></Card> : <ul className="plain">{rows.map((a) => (
        <li key={a.id}><Card title={new Date(a.startsAt).toLocaleString()} actions={<Badge tone={a.status === 'CONFIRMED' ? 'ok' : 'warn'}>{a.status === 'CONFIRMED' ? 'Confirmed' : 'Waiting for you'}</Badge>}>
          <p className="muted">{Math.round((Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60_000)} minutes{a.meetingRef ? ` · ${a.meetingRef}` : ''} · {a.ticketId && <Link to={`/staff/doubts/tickets/${a.ticketId}`}>Open the ticket</Link>}</p>
          <div className="choices">{a.status === 'REQUESTED' && <><label htmlFor={`ap-${a.id}`}>Meeting link or room (optional)</label><input id={`ap-${a.id}`} value={ref[a.id] ?? ''} onChange={(e) => setRef({ ...ref, [a.id]: e.target.value })} /><button onClick={() => void act(() => api.post(`/v1/teacher/appointments/${a.id}/confirm`, ref[a.id]?.trim() ? { meetingRef: ref[a.id].trim() } : {}), 'Confirmed: the learner has been told.')}>Confirm</button></>}<button className="link" onClick={() => { if (window.confirm('Cancel this appointment? The learner is told.')) void act(() => api.post(`/v1/appointments/${a.id}/cancel`), 'Cancelled.'); }}>Cancel appointment</button></div>
        </Card></li>))}</ul>}
    </>
  );
}
