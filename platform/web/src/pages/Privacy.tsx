import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { Consent, Prefs, PrivacyRequest } from '../api/types';
import { Badge, Card, ErrorNote, Hold } from '../components/ui';
import { usePrefs } from '../prefs';
import { canDownload, describeRequest, hasOpen, PURPOSES, typeLabel } from '../lib/privacy';
import { idempotencyKey } from '../lib/format';
import { chooseLang, fmtDate, fmtDateTime, LANGS, mark, useT } from '../lib/i18n';
import { useAuth } from '../auth';

export default function Privacy() {
  const t = useT(); const [consents, setConsents] = useState<Consent[] | null>(null); const [reqs, setReqs] = useState<PrivacyRequest[] | null>(null); const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => { try { const [c, r] = await Promise.all([api.get<Consent[]>('/v1/me/consents'), api.get<PrivacyRequest[]>('/v1/me/privacy/requests')]); setConsents(c); setReqs(r); } catch (e) { setError(e); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (!consents || !reqs) return <Hold title={t('Privacy and data')} error={error} what={t('Loading your privacy settings')} />;
  return (
    <div>
      <h1>{t('Privacy and data')}</h1>
      <p className="muted">{t('You are in control of how your information is used. Everything you do here is recorded in an audit trail.')}</p>
      <ConsentCard consents={consents} onChange={setConsents} />
      <DataRequests reqs={reqs} reload={load} />
      <PreferencesCard />
    </div>
  );
}

function ConsentCard({ consents, onChange }: { consents: Consent[]; onChange: (c: Consent[]) => void }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<unknown>(null);
  const toggle = async (c: Consent, granted: boolean) => { setBusy(c.purpose); setError(null); try { onChange(await api.request<Consent[]>('PUT', '/v1/me/consents', { body: { purpose: c.purpose, granted, version: c.currentNoticeVersion } })); } catch (e) { setError(e); } finally { setBusy(null); } };
  return (
    <Card title={t('Your consents')}>
      <ErrorNote error={error} />
      <ul className="plain">{consents.map((c) => { const info = PURPOSES[c.purpose] ?? { title: c.purpose, text: '' }; const on = c.granted && c.upToDate; return (
        <li key={c.purpose} className="dim"><div className="row"><h3>{t(info.title)}</h3><label className="switch"><input type="checkbox" role="switch" checked={on} disabled={busy === c.purpose} aria-label={t('{title} consent', { title: t(info.title) })} onChange={(e) => void toggle(c, e.target.checked)} /> {on ? t('On') : t('Off')}</label></div>
          <p>{t(info.text)}</p>
          {c.granted && !c.upToDate && <p className="note warn">{t('The privacy notice has changed (now version {version}). Please review and confirm your choice again.', { version: c.currentNoticeVersion })}</p>}
          {info.caution && on && <p className="muted">{t(info.caution)}</p>}
          <p className="muted">{c.at ? t('Last changed {date} (notice {version})', { date: fmtDate(c.at, {}), version: c.version ?? '' }) : t('No choice recorded yet.')}</p></li>); })}</ul>
    </Card>
  );
}

type Mode = null | 'EXPORT' | 'CORRECTION' | 'ERASURE';
function DataRequests({ reqs, reload }: { reqs: PrivacyRequest[]; reload: () => Promise<void> }) {
  const t = useT();
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
  const Btn = ({ kind, label }: { kind: Exclude<Mode, null>; label: string }) => <button className="secondary" disabled={hasOpen(reqs, kind)} onClick={() => { setMode(kind); setError(null); }} title={hasOpen(reqs, kind) ? t('You already have an open request of this kind') : undefined}>{label}</button>;
  return (
    <Card title={t('Your data')}>
      <p>{t('You can ask for a copy of your data, ask us to correct it, or ask us to erase it.')}</p>
      <div className="choices"><Btn kind="EXPORT" label={t('Download my data')} /><Btn kind="CORRECTION" label={t('Correct my details')} /><Btn kind="ERASURE" label={t('Erase my data')} /></div>
      {mode && (
        <form onSubmit={submit} className="card inner" aria-label={typeLabel(mode)}>
          <h3>{mode === 'EXPORT' ? t('Download my data') : mode === 'CORRECTION' ? t('Correct my details') : t('Erase my data')}</h3>
          {mode === 'EXPORT' && <p>{t('We will prepare a file with your profile, course progress, submissions, grades, tutor and doubt conversations and consents. It is encrypted while stored and the download link expires after a few days.')}</p>}
          {mode === 'CORRECTION' && (<><label htmlFor="c-name">{t('Name')}</label><input id="c-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /><label htmlFor="c-lang">{t('Language')}</label>
            <select id="c-lang" value={language} onChange={(e) => setLanguage(e.target.value)}><option value="">{t('No change')}</option>{LANGS.map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}</select><p className="muted">{t('A member of staff will check and approve the change.')}</p></>)}
          {mode === 'ERASURE' && (<>
            <p className="note warn" role="alert"><strong>{t('This cannot be undone.')}</strong> {t('Your personal details and conversations are erased. A pseudonymised record of your academic results is kept as the institute is required to. Erasure cannot go ahead while you have an active course or a legal hold applies; staff must approve it.')}</p>
            <label htmlFor="e-why">{t('Why are you asking? (optional)')}</label><textarea id="e-why" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            <label htmlFor="e-conf">{t('Type ERASE to confirm')}</label><input id="e-conf" value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} /></>)}
          {mode !== 'CORRECTION' && (<><label htmlFor="p-pass">{t('Confirm your password')}</label><input id="p-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></>)}
          <ErrorNote error={error} />
          <div className="choices"><button type="submit" disabled={busy || !valid}>{busy ? t('Sending…') : t('Send request')}</button><button type="button" className="secondary" onClick={close}>{t('Cancel')}</button></div>
        </form>)}
      {!mode && <ErrorNote error={error} />}
      <h3>{t('Your requests')}</h3>
      {!reqs.length ? <p className="muted">{t('You have not made any requests.')}</p> : (
        <ul className="plain">{reqs.map((r) => { const i = describeRequest(r); return (
          <li key={r.id} className="dim"><div className="row"><span className="strong">{typeLabel(r.type)}</span><Badge tone={i.tone}>{i.label}</Badge></div>
            <p className="muted">{t('Requested {when}', { when: fmtDateTime(r.requestedAt) })}</p>{i.blurb && <p>{i.blurb}</p>}
            {canDownload(r) && <><button onClick={() => void download(r)}>{t('Download')}</button> <span className="muted">{t('Available until {date}', { date: fmtDate(r.exportExpiresAt!, {}) })}</span></>}</li>); })}</ul>)}
    </Card>
  );
}

const TOGGLES: [keyof Prefs, string, string][] = [
  ['captions', mark('Show captions'), mark('Show subtitles on videos when they have them.')],
  ['highContrast', mark('High contrast'), mark('Stronger colours and borders.')], ['reducedMotion', mark('Reduce motion'), mark('Turns off animations.')], ['largeTargets', mark('Larger buttons and inputs'), mark('Easier to tap or click.')],
  ['transcriptByDefault', mark('Show transcripts by default'), mark('Open the transcript under every video.')], ['lowBandwidth', mark('Low-bandwidth mode by default'), mark('Audio and transcript instead of video.')],
];
function PreferencesCard() {
  const t = useT(); const { me } = useAuth(); const { prefs, save } = usePrefs(); const [error, setError] = useState<unknown>(null);
  const set = async (c: Partial<Prefs>) => { setError(null); try { await save(c); } catch (e) { setError(e); } };
  return (
    <Card title={t('Accessibility and language')}>
      <ErrorNote error={error} />
      <ul className="plain">{TOGGLES.map(([k, label, hint]) => (
        <li key={k} className="row dim"><div><span className="strong">{t(label)}</span><br /><span className="muted">{t(hint)}</span></div>
          <label className="switch"><input type="checkbox" role="switch" aria-label={t(label)} checked={k === 'captions' ? prefs.captions !== false : !!prefs[k]} onChange={(e) => void set({ [k]: e.target.checked })} /> {(k === 'captions' ? prefs.captions !== false : prefs[k]) ? t('On') : t('Off')}</label></li>))}</ul>
      <label htmlFor="pf-font">{t('Text size ({n}%)', { n: Math.round((prefs.fontScale ?? 1) * 100) })}</label><input id="pf-font" type="range" min={0.8} max={2.5} step={0.1} value={prefs.fontScale ?? 1} onChange={(e) => void set({ fontScale: Number(e.target.value) })} />
      <label htmlFor="pf-sp">{t('Text spacing')}</label><select id="pf-sp" value={prefs.textSpacing ?? 'normal'} onChange={(e) => void set({ textSpacing: e.target.value as Prefs['textSpacing'] })}><option value="normal">{t('Normal')}</option><option value="wide">{t('Wide')}</option><option value="wider">{t('Wider')}</option></select>
      <label htmlFor="pf-speed">{t('Video speed')}</label><select id="pf-speed" value={String(prefs.playbackSpeed ?? 1)} onChange={(e) => void set({ playbackSpeed: Number(e.target.value) })}>{[0.75, 1, 1.25, 1.5, 2].map((s) => <option key={s} value={s}>{s}x</option>)}</select>
      <label htmlFor="pf-cs">{t('Caption size')}</label><select id="pf-cs" value={prefs.captionSize ?? 'normal'} onChange={(e) => void set({ captionSize: e.target.value as Prefs['captionSize'] })}><option value="normal">{t('Normal')}</option><option value="large">{t('Large')}</option><option value="larger">{t('Larger')}</option></select>
      <label className="switch" style={{ marginTop: 8 }}><input type="checkbox" role="switch" checked={prefs.captionBackground !== false} onChange={(e) => void set({ captionBackground: e.target.checked })} /> {t('Dark background behind captions')}</label>
      <label htmlFor="pf-cl">{t('Caption language')}</label><select id="pf-cl" value={prefs.captionLanguage ?? prefs.language ?? 'en'} onChange={(e) => void set({ captionLanguage: e.target.value as 'en' | 'hi' })}>{LANGS.map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}</select>
      <label htmlFor="pf-lang">{t('Language')}</label><select id="pf-lang" value={prefs.language ?? chooseLang(undefined, me?.language)} onChange={(e) => void set({ language: e.target.value as 'en' | 'hi' })}>{LANGS.map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}</select>
      <p className="muted">{t('The screens and the course content are shown in this language where a translation exists. Course videos and captions follow your caption language when that version has been published.')}</p>
    </Card>
  );
}
