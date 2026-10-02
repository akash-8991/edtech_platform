import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { ProgrammeRow, VersionSummary } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { needsMe, stateLabel, stateTone } from '../lib/content';
import { AREAS, canSee, hasAny } from '../lib/roles';

export default function Content() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'content')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <Index roles={me!.roles} canWrite={hasAny(me?.roles, AREAS.content.act)} />;
}

function Index({ roles, canWrite }: { roles: string[]; canWrite: boolean }) {
  const [rows, setRows] = useState<ProgrammeRow[] | null>(null); const [error, setError] = useState<unknown>(null); const [filter, setFilter] = useState<'ALL' | 'MINE'>('ALL');
  const load = useCallback(async () => { try { setRows(await api.get<ProgrammeRow[]>('/v1/authoring/programmes')); setError(null); } catch (e) { setError(e); } }, []);
  useEffect(() => { void load(); }, [load]);
  const waiting = rows ? rows.flatMap((p) => p.versions).filter((v) => needsMe(v.state, roles)).length : 0;
  return (
    <div>
      <h1>Content</h1>
      <p className="muted">Every programme and each of its versions. A version moves from draft through faculty review and final approval to published; nobody can approve their own work.</p>
      <div className="tabs" role="group" aria-label="Show"><button aria-pressed={filter === 'ALL'} onClick={() => setFilter('ALL')}>All programmes</button><button aria-pressed={filter === 'MINE'} onClick={() => setFilter('MINE')}>Needs my action{rows ? ` (${waiting})` : ''}</button></div>
      <ErrorNote error={error} />
      {canWrite && <NewProgramme onDone={load} />}
      {!rows ? (!error && <Loading what="Loading programmes" />) : !rows.length ? <Card><p>No programmes yet.{canWrite ? ' Create the first one above.' : ''}</p></Card> : rows.map((p) => {
        const vs = filter === 'MINE' ? p.versions.filter((v) => needsMe(v.state, roles)) : p.versions; if (filter === 'MINE' && !vs.length) return null;
        return (
          <Card key={p.id} title={<>{p.title} <span className="muted">({p.code})</span></>} actions={<span className="muted">{p.discipline}</span>}>
            {!vs.length ? <p className="muted">No versions yet.</p> : <ul className="plain">{vs.map((v) => <li key={v.id}><VersionLine v={v} mine={needsMe(v.state, roles)} /></li>)}</ul>}
            {canWrite && filter === 'ALL' && <NewVersion code={p.code} latest={p.versions[0]} onDone={load} />}
          </Card>);
      })}
    </div>
  );
}

function VersionLine({ v, mine }: { v: VersionSummary; mine: boolean }) {
  const ai = typeof v.provenance?.source === 'string' && v.provenance.source !== 'manual';
  return (
    <p className="line"><Link to={`/staff/content/versions/${v.id}`}>Version {v.version}</Link> <Badge tone={stateTone(v.state)}>{stateLabel(v.state)}</Badge> {ai && <Badge tone="warn">AI-assisted</Badge>} {mine && <Badge tone="ok">Needs you</Badge>} <span className="muted">· {v.hours} h · {v.languages.map((l) => (l === 'hi' ? 'Hindi' : 'English')).join(' + ')} · by {v.authorName ?? 'unknown'} · {new Date(v.createdAt).toLocaleDateString()}</span></p>
  );
}

function NewProgramme({ onDone }: { onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false); const [f, setF] = useState({ code: '', title: '', discipline: '' }); const [problem, setProblem] = useState<string | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const submit = async () => {
    const code = f.code.trim(); setProblem(!code ? 'Give the programme a short code (for example AIML-12).' : !f.title.trim() ? 'Give the programme a title.' : !f.discipline.trim() ? 'Say which discipline it belongs to.' : null); if (!code || !f.title.trim() || !f.discipline.trim()) return;
    setBusy(true); setError(null); try { await api.post('/v1/authoring/programmes', { code, title: f.title.trim(), discipline: f.discipline.trim() }); setOpen(false); setF({ code: '', title: '', discipline: '' }); await onDone(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  if (!open) return <p><button onClick={() => setOpen(true)}>New programme</button></p>;
  return (
    <Card title="New programme">
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        {([['code', 'Code'], ['title', 'Title'], ['discipline', 'Discipline']] as const).map(([k, l]) => <div key={k}><label htmlFor={`np-${k}`}>{l}</label><input id={`np-${k}`} value={f[k]} onChange={(e) => { setF({ ...f, [k]: e.target.value }); setProblem(null); }} /></div>)}
        {problem && <p role="alert" className="note error">{problem}</p>}<ErrorNote error={error} />
        <div className="choices"><button disabled={busy}>{busy ? 'Creating…' : 'Create programme'}</button><button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </Card>
  );
}

function NewVersion({ code, latest, onDone }: { code: string; latest?: VersionSummary; onDone: () => Promise<void> }) {
  const nav = useNavigate(); const [open, setOpen] = useState(false); const [hours, setHours] = useState('1'); const [langs, setLangs] = useState<string[]>(['en']); const [outcomes, setOutcomes] = useState('');
  const [problem, setProblem] = useState<string | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const create = async (fn: () => Promise<{ id: string }>) => { setBusy(true); setError(null); try { const v = await fn(); await onDone(); nav(`/staff/content/versions/${v.id}`); } catch (e) { setError(e); } finally { setBusy(false); } };
  const fresh = () => {
    const h = Number(hours); const p = !Number.isInteger(h) || h < 1 ? 'Hours must be a whole number, 1 or more.' : !langs.length ? 'Choose at least one language.' : null; setProblem(p); if (p) return;
    void create(() => api.post(`/v1/authoring/programmes/${code}/versions`, { hours: h, languages: langs, outcomes: outcomes.split('\n').map((x) => x.trim()).filter(Boolean), provenance: { source: 'manual' }, modules: [{ title: 'Module 1', topics: [{ title: 'Topic 1', hours: h }] }] }));
  };
  if (!open) return <p className="choices"><button onClick={() => setOpen(true)}>New version</button>{latest && <button onClick={() => void create(() => api.post(`/v1/authoring/versions/${latest.id}/clone`))} disabled={busy}>Copy version {latest.version} into a new draft</button>}<ErrorNote error={error} /></p>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); fresh(); }} noValidate className="subcard">
      <h3>New version of {code}</h3><p className="muted">Starts with one module and one topic. Build the rest on the next screen.</p>
      <label htmlFor={`nv-h-${code}`}>Total hours</label><input id={`nv-h-${code}`} inputMode="numeric" value={hours} onChange={(e) => { setHours(e.target.value); setProblem(null); }} style={{ width: '6rem' }} />
      <fieldset><legend>Languages</legend>{[['en', 'English'], ['hi', 'Hindi']].map(([k, l]) => <label key={k} className="inline"><input type="checkbox" checked={langs.includes(k)} onChange={(e) => { setLangs(e.target.checked ? [...langs, k] : langs.filter((x) => x !== k)); setProblem(null); }} /> {l}</label>)}</fieldset>
      <label htmlFor={`nv-o-${code}`}>Learning outcomes (one per line)</label><textarea id={`nv-o-${code}`} value={outcomes} onChange={(e) => setOutcomes(e.target.value)} />
      {problem && <p role="alert" className="note error">{problem}</p>}<ErrorNote error={error} />
      <div className="choices"><button disabled={busy}>{busy ? 'Creating…' : 'Create draft'}</button><button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}
