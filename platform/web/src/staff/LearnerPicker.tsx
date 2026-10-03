import { useState } from 'react';
import { api } from '../api/client';
import { ErrorNote } from '../components/ui';

export interface PickedLearner { id: string; name: string; email?: string }
/** Finds one learner by at least three letters of their name or email (the server refuses to list everyone). */
export function LearnerPicker({ value, onChange, idPrefix }: { value: PickedLearner | null; onChange: (l: PickedLearner | null) => void; idPrefix: string }) {
  const [q, setQ] = useState(''); const [found, setFound] = useState<PickedLearner[] | null>(null); const [error, setError] = useState<unknown>(null); const [short, setShort] = useState(false);
  const search = async () => { if (q.trim().length < 3) { setShort(true); return; } setShort(false); setError(null); setFound(null); try { setFound(await api.get<PickedLearner[]>(`/v1/admin/users?role=LEARNER&q=${encodeURIComponent(q.trim())}&limit=10`)); } catch (e) { setError(e); } };
  if (value) return <p>Learner: <strong>{value.name}</strong> <span className="muted">{value.email}</span> <button type="button" className="link" onClick={() => onChange(null)}>Choose someone else</button></p>;
  return (
    <div>
      <label htmlFor={`${idPrefix}-q`}>Find the learner (at least 3 letters of their name or email)</label>
      <div className="choices"><input id={`${idPrefix}-q`} value={q} onChange={(e) => { setQ(e.target.value); setShort(false); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} style={{ flex: 1 }} /><button type="button" onClick={() => void search()}>Find</button></div>
      {short && <p role="alert" className="note error">Type at least 3 letters.</p>}<ErrorNote error={error} />
      {found && (!found.length ? <p>No learner matches.</p> : <ul className="plain">{found.map((u) => <li key={u.id}><button type="button" className="link" onClick={() => { onChange(u); setFound(null); }}>{u.name}</button> <span className="muted">{u.email}</span></li>)}</ul>)}
    </div>
  );
}
