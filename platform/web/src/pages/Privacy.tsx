import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { Consent, Prefs, PrivacyRequest } from '../api/types';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { usePrefs } from '../prefs';
import { canDownload, describeRequest, hasOpen, PURPOSES, typeLabel } from '../lib/privacy';
import { idempotencyKey } from '../lib/format';

export default function Privacy() {
  const [consents, setConsents] = useState<Consent[] | null>(null); const [reqs, setReqs] = useState<PrivacyRequest[] | null>(null); const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => { try { const [c, r] = await Promise.all([api.get<Consent[]>('/v1/me/consents'), api.get<PrivacyRequest[]>('/v1/me/privacy/requests')]); setConsents(c); setReqs(r); } catch (e) { setError(e); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (!consents || !reqs) return error ? <ErrorNote error={error} /> : <Loading what="Loading your privacy settings" />;
  return (
    <div>
      <h1>Privacy and data</h1>
      <p className="muted">You are in control of how your information is used. Everything you do here is recorded in an audit trail.</p>
      <ConsentCard consents={consents} onChange={setConsents} />
      <DataRequests reqs={reqs} reload={load} />
      <PreferencesCard />
    </div>
  );
}

function ConsentCard({ consents, onChange }: { consents: Consent[]; onChange: (c: Consent[]) => void }) {
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<unknown>(null);
  const toggle = async (c: Consent, granted: boolean) => { setBusy(c.purpose); setError(null); try { onChange(await api.request<Consent[]>('PUT', '/v1/me/consents', { body: { purpose: c.purpose, granted, version: c.currentNoticeVersion } })); } catch (e) { setError(e); } finally { setBusy(null); } };
  return (
    <Card title="Your consents">
      <ErrorNote error={error} />
      <ul className="plain">{consents.map((c) => { const info = PURPOSES[c.purpose] ?? { title: c.purpose, text: '' }; const on = c.granted && c.upToDate; return (
        <li key={c.purpose} className="dim"><div className="row"><h3>{info.title}</h3><label className="switch"><input type="checkbox" role="switch" checked={on} disabled={busy === c.purpose} aria-label={`${info.title} consent`} onChange={(e) => void toggle(c, e.target.checked)} /> {on ? 'On' : 'Off'}</label></div>
          <p>{info.text}</p>
          {c.granted && !c.upToDate && <p className="note warn">The privacy notice has changed (now version {c.currentNoticeVersion}). Please review and confirm your choice again.</p>}
          {info.caution && on && <p className="muted">{info.caution}</p>}
          <p className="muted">{c.at ? `Last changed ${new Date(c.at).toLocaleDateString()} (notice ${c.version})` : 'No choice recorded yet.'}</p></li>); })}</ul>
    </Card>
  );
}

type Mode = null | 'EXPORT' | 'CORRECTION' | 'ERASURE';
function DataRequests({ reqs, reload }: { reqs: PrivacyRequest[]; reload: () => Promise<void> }) {
  const [mode, setMode] = useState<Mode>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState(''); const [name, setName] = useState(''); const [language, setLanguage] = useState(''); const [reason, setReason] = useState(''); const [confirm, setConfirm] = useState('');
  const [key, setKey] = useState(idempotencyKey);
  const close = () => { setMode(null); setPassword(''); setName(''); setLanguage(''); setReason(''); setConfirm(''); setError(null); setKey(idempotencyKey()); };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!mode) return; setBusy(true); setError(null);
    const details = mode === 'CORRECTION' ? { ...(name.trim() && { name: name.trim() }), ...(language && { language }) } : mode === 'ERASURE' ? { reason: reason.trim() } : undefined;
    try { await api.post('/v1/me/privacy/requests', { type: mode, ...(details && { details }), ...(mode !== 'CORRECTION' && { password }) }, key); close(); await reload(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const download = async (r: PrivacyRequest) => { setError(null); try { const blob = await api.download(`/v1/me/privacy/requests/${r.id}/download`); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'my-data.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (err) { setError(err); } };
  const valid = mode === 'EXPORT' ? !!password : mode === 'CORRECTION' ? !!(name.trim() || language) : mode === 'ERASURE' ? !!password && confirm === 'ERASE' : false;
  const Btn = ({ t, label }: { t: Exclude<Mode, null>; label: string }) => <button className="secondary" disabled={hasOpen(reqs, t)} onClick={() => { setMode(t); setError(null); }} title={hasOpen(reqs, t) ? 'You already have an open request of this kind' : undefined}>{label}</button>;
  return (
    <Card title="Your data">
      <p>You can ask for a copy of your data, ask us to correct it, or ask us to erase it.</p>
      <div className="choices"><Btn t="EXPORT" label="Download my data" /><Btn t="CORRECTION" label="Correct my details" /><Btn t="ERASURE" label="Erase my data" /></div>
      {mode && (
        <form onSubmit={submit} className="card inner" aria-label={typeLabel(mode)}>
          <h3>{mode === 'EXPORT' ? 'Download my data' : mode === 'CORRECTION' ? 'Correct my details' : 'Erase my data'}</h3>
          {mode === 'EXPORT' && <p>We will prepare a file with your profile, course progress, submissions, grades, tutor and doubt conversations and consents. It is encrypted while stored and the download link expires after a few days.</p>}
          {mode === 'CORRECTION' && (<><label htmlFor="c-name">Name</label><input id="c-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /><label htmlFor="c-lang">Language</label>
            <select id="c-lang" value={language} onChange={(e) => setLanguage(e.target.value)}><option value="">No change</option><option value="en">English</option><option value="hi">Hindi</option></select><p className="muted">A member of staff will check and approve the change.</p></>)}
          {mode === 'ERASURE' && (<>
            <p className="note warn" role="alert"><strong>This cannot be undone.</strong> Your personal details and conversations are erased. A pseudonymised record of your academic results is kept as the institute is required to. Erasure cannot go ahead while you have an active course or a legal hold applies; staff must approve it.</p>
            <label htmlFor="e-why">Why are you asking? (optional)</label><textarea id="e-why" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            <label htmlFor="e-conf">Type <strong>ERASE</strong> to confirm</label><input id="e-conf" value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} /></>)}
          {mode !== 'CORRECTION' && (<><label htmlFor="p-pass">Confirm your password</label><input id="p-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></>)}
          <ErrorNote error={error} />
          <div className="choices"><button type="submit" disabled={busy || !valid}>{busy ? 'Sending…' : 'Send request'}</button><button type="button" className="secondary" onClick={close}>Cancel</button></div>
        </form>)}
      {!mode && <ErrorNote error={error} />}
      <h3>Your requests</h3>
      {!reqs.length ? <p className="muted">You have not made any requests.</p> : (
        <ul className="plain">{reqs.map((r) => { const i = describeRequest(r); return (
          <li key={r.id} className="dim"><div className="row"><span className="strong">{typeLabel(r.type)}</span><Badge tone={i.tone}>{i.label}</Badge></div>
            <p className="muted">Requested {new Date(r.requestedAt).toLocaleString()}</p>{i.blurb && <p>{i.blurb}</p>}
            {canDownload(r) && <><button onClick={() => void download(r)}>Download</button> <span className="muted">Available until {new Date(r.exportExpiresAt!).toLocaleDateString()}</span></>}</li>); })}</ul>)}
    </Card>
  );
}

const TOGGLES: [keyof Prefs, string, string][] = [
  ['highContrast', 'High contrast', 'Stronger colours and borders.'], ['reducedMotion', 'Reduce motion', 'Turns off animations.'], ['largeTargets', 'Larger buttons and inputs', 'Easier to tap or click.'],
  ['transcriptByDefault', 'Show transcripts by default', 'Open the transcript under every video.'], ['lowBandwidth', 'Low-bandwidth mode by default', 'Audio and transcript instead of video.'],
];
function PreferencesCard() {
  const { prefs, save } = usePrefs(); const [error, setError] = useState<unknown>(null);
  const set = async (c: Partial<Prefs>) => { setError(null); try { await save(c); } catch (e) { setError(e); } };
  return (
    <Card title="Accessibility and language">
      <ErrorNote error={error} />
      <ul className="plain">{TOGGLES.map(([k, label, hint]) => (
        <li key={k} className="row dim"><div><span className="strong">{label}</span><br /><span className="muted">{hint}</span></div>
          <label className="switch"><input type="checkbox" role="switch" aria-label={label} checked={!!prefs[k]} onChange={(e) => void set({ [k]: e.target.checked })} /> {prefs[k] ? 'On' : 'Off'}</label></li>))}</ul>
      <label htmlFor="pf-font">Text size ({Math.round((prefs.fontScale ?? 1) * 100)}%)</label><input id="pf-font" type="range" min={0.8} max={2.5} step={0.1} value={prefs.fontScale ?? 1} onChange={(e) => void set({ fontScale: Number(e.target.value) })} />
      <label htmlFor="pf-sp">Text spacing</label><select id="pf-sp" value={prefs.textSpacing ?? 'normal'} onChange={(e) => void set({ textSpacing: e.target.value as Prefs['textSpacing'] })}><option value="normal">Normal</option><option value="wide">Wide</option><option value="wider">Wider</option></select>
      <label htmlFor="pf-speed">Video speed</label><select id="pf-speed" value={String(prefs.playbackSpeed ?? 1)} onChange={(e) => void set({ playbackSpeed: Number(e.target.value) })}>{[0.75, 1, 1.25, 1.5, 2].map((s) => <option key={s} value={s}>{s}x</option>)}</select>
      <label htmlFor="pf-lang">Language</label><select id="pf-lang" value={prefs.language ?? 'en'} onChange={(e) => void set({ language: e.target.value as 'en' | 'hi' })}><option value="en">English</option><option value="hi">Hindi</option></select>
      <p className="muted">Hindi changes the language of content shown to you where it exists; the screens themselves are not translated yet.</p>
    </Card>
  );
}
