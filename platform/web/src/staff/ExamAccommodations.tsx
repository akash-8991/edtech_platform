import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AccommodationRow } from '../api/types';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { accommodationText, reasonError, validateAccommodation } from '../lib/examsetup';
import { LearnerPicker, type PickedLearner } from './LearnerPicker';

/** Extra time, breaks and assistive technology for named learners. Only the learner's own clock changes; each grant is audited with the reason. */
export function Accommodations() {
  const [rows, setRows] = useState<AccommodationRow[] | null>(null); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState<string | null>(null); const [showAll, setShowAll] = useState(false);
  const load = useCallback(async (clear = true) => { try { setRows(await api.get<AccommodationRow[]>(`/v1/exams/accommodations${showAll ? '' : '?active=true'}`)); if (clear) setError(null); } catch (e) { setError(e); } }, [showAll]);
  useEffect(() => { setRows(null); void load(); }, [load]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); setDone(null); try { await fn(); setDone(ok); await load(false); return true; } catch (e) { setError(e); return false; } };
  return (
    <>
      <Grant onGrant={(b) => act(() => api.post('/v1/exams/accommodations', b), 'Accommodation granted. It applies to the learner\'s own exam clock.')} />
      <ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}
      <Card title="Accommodations" actions={<label className="inline"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Include withdrawn</label>}>
        {!rows ? (!error && <Loading />) : !rows.length ? <p>None{showAll ? '' : ' in force'}.</p> : <ul className="plain">{rows.map((a) => (
          <li key={a.id} className="subcard"><p><strong>{a.learnerName ?? 'Unknown learner'}</strong> <span className="muted">{a.learnerEmail}</span> <Badge tone={a.active ? 'ok' : 'muted'}>{a.active ? accommodationText(a) : `Withdrawn: ${accommodationText(a)}`}</Badge></p>
            <p className="muted">{a.examId ? 'For one exam' : 'For every exam'} · granted by {a.approvedByName ?? 'staff'} on {new Date(a.createdAt).toLocaleDateString()} · {a.reason}</p>
            {a.active && <Withdraw onGo={(r) => act(() => api.post(`/v1/exams/accommodations/${a.id}/deactivate`, { reason: r }), 'Withdrawn.')} />}</li>))}</ul>}
      </Card>
    </>
  );
}

function Grant({ onGrant }: { onGrant: (b: object) => Promise<boolean> }) {
  const [open, setOpen] = useState(false); const [who, setWho] = useState<PickedLearner | null>(null); const [f, setF] = useState({ type: '', percent: '25', reason: '' }); const [problem, setProblem] = useState<string | null>(null);
  if (!open) return <p><button onClick={() => setOpen(true)}>Grant an accommodation</button></p>;
  return (
    <Card title="Grant an accommodation">
      <form onSubmit={(e) => { e.preventDefault(); const p = validateAccommodation({ learnerId: who?.id ?? '', ...f }); setProblem(p); if (p) return; void onGrant({ learnerId: who!.id, type: f.type, ...(f.type === 'EXTRA_TIME' && { extraTimePercent: Number(f.percent) }), reason: f.reason.trim() }).then((ok) => { if (ok) { setOpen(false); setWho(null); setF({ type: '', percent: '25', reason: '' }); } }); }} noValidate>
        <LearnerPicker value={who} onChange={(l) => { setWho(l); setProblem(null); }} idPrefix="ga" />
        <label htmlFor="ga-t">Kind</label><select id="ga-t" value={f.type} onChange={(e) => { setF({ ...f, type: e.target.value }); setProblem(null); }}><option value="">Choose…</option><option value="EXTRA_TIME">Extra time</option><option value="BREAKS">Breaks</option><option value="ASSISTIVE">Assistive technology</option></select>
        {f.type === 'EXTRA_TIME' && <><label htmlFor="ga-p">Extra time (% of the exam length)</label><input id="ga-p" inputMode="numeric" value={f.percent} onChange={(e) => { setF({ ...f, percent: e.target.value }); setProblem(null); }} style={{ width: '6rem' }} /></>}
        <label htmlFor="ga-r">Reason, for example the documented need (recorded in the audit trail)</label><textarea id="ga-r" value={f.reason} onChange={(e) => { setF({ ...f, reason: e.target.value }); setProblem(null); }} />
        <p className="muted">It applies to every exam this learner sits. Extra time never runs past the end of the sitting window.</p>
        {problem && <p role="alert" className="note error">{problem}</p>}<div className="choices"><button>Grant</button><button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </Card>
  );
}

function Withdraw({ onGo }: { onGo: (r: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false); const [r, setR] = useState(''); const [problem, setProblem] = useState<string | null>(null);
  if (!open) return <button className="link" onClick={() => setOpen(true)}>Withdraw…</button>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); const p = reasonError(r); setProblem(p); if (!p) void onGo(r.trim()); }} noValidate>
      <label>Why it is withdrawn<textarea value={r} onChange={(e) => { setR(e.target.value); setProblem(null); }} /></label>{problem && <p role="alert" className="note error">{problem}</p>}
      <div className="choices"><button>Withdraw</button><button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}
