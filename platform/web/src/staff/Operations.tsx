import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../api/client';
import type { ConfigItem, ExamOpsStatus, IntegrityReport } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { CONFIG_ROLES, EXAM_STATUS_ROLES, hasAny, INTEGRITY_ROLES, canSee } from '../lib/roles';
import { configToText, parseConfigInput, RISKY_KEYS, sameValue } from '../lib/staff';

export default function Operations() {
  const { me } = useAuth(); const roles = me?.roles;
  if (!canSee(roles, 'operations')) return <Navigate to="/staff" replace />;
  return (
    <div>
      <h1>Operations</h1>
      {hasAny(roles, EXAM_STATUS_ROLES) && <ExamStatus />}
      {hasAny(roles, INTEGRITY_ROLES) && <Integrity />}
      {hasAny(roles, CONFIG_ROLES) && <Settings />}
    </div>
  );
}

function ExamStatus({ pollMs = 15_000 }: { pollMs?: number }) {
  const [s, setS] = useState<ExamOpsStatus | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { let alive = true; const go = () => api.get<ExamOpsStatus>('/v1/exam-ops/status').then((x) => { if (alive) { setS(x); setError(null); } }).catch((e) => alive && setError(e)); void go(); const t = setInterval(go, pollMs); return () => { alive = false; clearInterval(t); }; }, [pollMs]);
  const inc = s ? Object.values(s.openIncidents).reduce((a, b) => a + b, 0) : 0;
  return (
    <Card title="Exams right now" actions={<span className="muted">refreshes every {Math.round(pollMs / 1000)}s</span>}>
      <ErrorNote error={error} />
      {!s ? (!error && <Loading />) : (
        <div className="stats" aria-live="polite">
          <Stat label="In progress" v={s.inProgress} /><Stat label="Autosave stale (90s+)" v={s.staleAutosave} warn={s.staleAutosave > 0} /><Stat label="Ending within 5 min" v={s.expiringWithin5Min} />
          <Stat label="Many window switches" v={s.highSessionSwitches} warn={s.highSessionSwitches > 0} /><Stat label="Open incidents" v={inc} warn={inc > 0} /><Stat label="Results held" v={s.heldResults} />
          <Stat label="Awaiting release" v={s.awaitingRelease} /><Stat label="Awaiting proctor report" v={s.remoteAwaitingProctorReport} /><Stat label="Open appeals" v={s.openAppeals} warn={s.openAppeals > 0} /></div>)}
    </Card>
  );
}
const Stat = ({ label, v, warn }: { label: string; v: number; warn?: boolean }) => <div className="stat"><span className="muted">{label}</span><b className={warn ? 'warnnum' : undefined}>{v}</b></div>;

function Integrity() {
  const [r, setR] = useState<IntegrityReport | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  const run = async () => { setBusy(true); setError(null); try { setR(await api.get<IntegrityReport>('/v1/ops/integrity')); } catch (e) { setError(e); } finally { setBusy(false); } };
  const orphans = r ? Object.entries(r.orphans).filter(([, n]) => n > 0) : [];
  return (
    <Card title="Integrity check" actions={r && <Badge tone={r.ok ? 'ok' : 'warn'}>{r.ok ? 'All checks passed' : 'PROBLEM FOUND'}</Badge>}>
      <p className="muted">Re-computes the audit trail's hash chain and every exam log's chain, and checks that records still point at each other. The worker also does this every few hours. It can take a while on a large database.</p>
      <button onClick={() => void run()} disabled={busy}>{busy ? 'Checking…' : 'Run full check now'}</button><ErrorNote error={error} />
      {r && (<div role="status" aria-live="polite">
        <p>Checked {new Date(r.checkedAt).toLocaleString()}.</p>
        <ul><li>Audit trail: {r.audit.events.toLocaleString()} events, {r.audit.intact ? 'chain intact' : <strong>chain BROKEN at event {r.audit.firstBroken}</strong>}</li>
          <li>Exam logs: {r.examLogs.attempts.toLocaleString()} attempts, {r.examLogs.broken.length ? <strong>{r.examLogs.broken.length} with a broken chain or missing events</strong> : 'all intact'}</li>
          <li>Linked records: {orphans.length ? <strong>{orphans.map(([k, n]) => `${k}: ${n}`).join(', ')}</strong> : 'no orphans'}</li></ul>
        {!r.ok && <p className="note error" role="alert"><strong>Treat this as a security incident.</strong> Freeze changes, keep a snapshot, and follow the integrity-failure runbook (docs/ops/runbooks.md). Do not try to repair records by hand.</p>}
        <details><summary>Record counts</summary><table className="grid"><tbody>{Object.entries(r.counts).map(([k, n]) => <tr key={k}><td>{k}</td><td>{n.toLocaleString()}</td></tr>)}</tbody></table></details></div>)}
    </Card>
  );
}

function Settings() {
  const { me } = useAuth(); const [items, setItems] = useState<ConfigItem[] | null>(null); const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api.get<ConfigItem[]>('/v1/admin/config').then(setItems).catch(setError), []);
  useEffect(() => { void load(); }, [load]);
  if (!items) return <Card title="Platform settings">{error ? <ErrorNote error={error} /> : <Loading />}</Card>;
  const groups = new Map<string, ConfigItem[]>(); for (const i of items) { const g = i.key.split('.')[0]; groups.set(g, [...(groups.get(g) ?? []), i]); }
  const risky = items.filter((i) => RISKY_KEYS.has(i.key)); const rest = (arr: ConfigItem[]) => arr.filter((i) => !RISKY_KEYS.has(i.key));
  return (
    <Card title="Platform settings">
      <p className="muted">Changes apply immediately, are checked by the server, and are recorded in the audit trail with your name ({me?.email}). Some settings may be restricted to platform administrators.</p>
      <ErrorNote error={error} />
      {risky.length > 0 && <section aria-label="Emergency controls" className="card inner"><h3>Emergency controls</h3>{risky.map((i) => <SettingRow key={i.key} item={i} onSaved={load} />)}</section>}
      {[...groups].map(([g, list]) => rest(list).length > 0 && (
        <details key={g}><summary><strong>{g}</strong> ({rest(list).length})</summary>{rest(list).map((i) => <SettingRow key={i.key} item={i} onSaved={load} />)}</details>))}
    </Card>
  );
}

export function SettingRow({ item, onSaved }: { item: ConfigItem; onSaved: () => Promise<unknown> | void }) {
  const [text, setText] = useState(configToText(item)); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null); const [confirm, setConfirm] = useState(false); const [saved, setSaved] = useState(false);
  useEffect(() => { setText(configToText(item)); }, [item.value]); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = parseConfigInput(item.kind, text); const changed = parsed.ok && !sameValue(parsed.value, item.value);
  const save = async () => { if (!parsed.ok) return; setBusy(true); setError(null); setSaved(false); try { await api.put(`/v1/admin/config/${item.key}`, { value: parsed.value }); setConfirm(false); setSaved(true); await onSaved(); } catch (e) { setError(e); } finally { setBusy(false); } };
  const id = `cfg-${item.key}`;
  return (
    <div className="dim" role="group" aria-label={item.key}>
      <div className="row"><label htmlFor={id} className="mono">{item.key}</label>{saved && <Badge tone="ok">Saved</Badge>}</div>
      <p className="muted">{item.doc}</p>
      {item.kind === 'boolean' ? <select id={id} value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }}><option value="true">On</option><option value="false">Off</option></select>
        : item.kind === 'number' ? <input id={id} type="number" step="any" value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }} />
        : <textarea id={id} rows={item.kind === 'string[]' ? 3 : 4} className={item.kind === 'string[]' ? '' : 'mono'} value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }} aria-describedby={`${id}-h`} />}
      {item.kind === 'string[]' && <p id={`${id}-h`} className="muted">One entry per line.</p>}
      {!parsed.ok && <p role="alert" className="note error">{parsed.error}</p>}<ErrorNote error={error} />
      {!confirm ? <button disabled={!changed || busy} onClick={() => (RISKY_KEYS.has(item.key) ? setConfirm(true) : void save())}>{busy ? 'Saving…' : 'Save'}</button> : (
        <div className="note warn" role="alertdialog" aria-label={`Confirm change to ${item.key}`}><p><strong>{item.key} affects the whole platform.</strong> Change it to “{item.kind === 'boolean' ? (text === 'true' ? 'On' : 'Off') : text}”?</p>
          <div className="choices"><button onClick={() => void save()} disabled={busy}>Yes, change it</button><button className="secondary" onClick={() => setConfirm(false)}>Cancel</button></div></div>)}
    </div>
  );
}
