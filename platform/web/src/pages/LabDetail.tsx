import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { EntitlementSummary, LabActivity, LabSlot, Progress, UploadedFile } from '../api/types';
import { Badge, Card, ErrorNote, Hold } from '../components/ui';
import { idempotencyKey } from '../lib/format';
import { attendanceWindow, blockers, prerequisiteBlockers, labStatus, liveBooking, looksLikeUrl, slotTime, tokenFromInput } from '../lib/labs';
import { useT } from '../lib/i18n';
import { QrScanner } from '../components/QrScanner';
import { cameraSupported } from '../lib/qr';

const ALLOWED = '.pdf,.txt,.md,.png,.jpg,.jpeg,.zip,.ipynb,.py,.csv,.doc,.docx,.mp4,.mp3';

export default function LabDetail() {
  const { activityId = '' } = useParams(); const t = useT();
  const [lab, setLab] = useState<LabActivity | null>(null); const [slots, setSlots] = useState<LabSlot[]>([]); const [titles, setTitles] = useState<Map<string, string>>(new Map()); const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null); const [notice, setNotice] = useState('');

  const load = useCallback(async (clearError = true) => {
    try {
      const all = await api.get<LabActivity[]>('/v1/me/labs'); const l = all.find((x) => x.activityId === activityId) ?? null; setLab(l);
      setSlots(l ? await api.get<LabSlot[]>(`/v1/labs/slots?activityId=${activityId}`) : []); if (clearError) setError(null);
    } catch (e) { setError(e); }
  }, [activityId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api.get<EntitlementSummary[]>('/v1/me/entitlements').then((ents) => Promise.all(ents.filter((e) => e.learningAccess).map((e) => api.get<Progress>(`/v1/me/entitlements/${e.id}/progress`).catch(() => null)))).then((ps) => { const names = new Map<string, string>(); ps.forEach((p) => p?.topics.forEach((x) => names.set(x.topicId, x.title))); setTitles(names); }).catch(() => undefined); }, []);

  const run = async (id: string, fn: () => Promise<unknown>, ok = '') => { setBusy(id); setError(null); setNotice(''); try { await fn(); setNotice(ok); await load(); } catch (e) { setError(e); await load(false); /* refresh seats and state, but keep the message the learner needs to read */ } finally { setBusy(null); } };
  if (!lab) return <Hold title={t('Lab')} error={error} what={t('Loading the lab')} />;
  const s = labStatus(lab); const b = liveBooking(lab); const why = blockers(lab, titles);
  return (
    <div>
      <p><Link to="/labs">{t('All labs')}</Link></p>
      <h1>{lab.title}</h1>
      <p><Badge tone={s.tone}>{s.label}</Badge> {lab.mandatory && <Badge tone="muted">{t('Mandatory')}</Badge>} {lab.location && <span className="muted">· {lab.location}</span>}</p>
      {notice && <p className="note ok" role="status">{notice}</p>}
      <ErrorNote error={error instanceof ApiError && error.code === 'not_eligible' ? new ApiError(409, { message: t('You cannot book yet: finish the steps listed below.') }) : error} />

      {lab.manual && <Card title={t('Lab manual')}>{looksLikeUrl(lab.manual) ? <a href={lab.manual.trim()} target="_blank" rel="noreferrer noopener">{t('Open the lab manual')}</a> : <p className="qtext">{lab.manual}</p>}</Card>}

      {!lab.completed && (
        <Card title={t('1. Safety notice')} actions={<Badge tone={lab.eligibility.safetyAcknowledged ? 'ok' : 'warn'}>{lab.eligibility.safetyAcknowledged ? t('Accepted') : t('Needs your acceptance')}</Badge>}>
          <p className="qtext">{lab.safetyText}</p>
          {lab.eligibility.safetyAcknowledged ? <p className="muted">{t('You have accepted this version of the notice.')}</p>
            : <button disabled={busy === 'ack'} onClick={() => void run('ack', () => api.post(`/v1/labs/activities/${lab.activityId}/ack`, { textHash: lab.safetyHash }), t('Safety notice accepted.'))}>{t('I have read and understood this notice')}</button>}
        </Card>)}

      {lab.eligibility.missingPrerequisiteTopics.length > 0 && !lab.completed && <Card title={t('Prerequisites')}><ul>{prerequisiteBlockers(lab, titles).map((w) => <li key={w}>{w}</li>)}</ul></Card>}

      {!lab.completed && !b && (
        <Card title={t('2. Choose a session')}>
          {!slots.length ? <p className="muted">{t('No sessions are open for booking right now. Check back soon.')}</p> : (
            <ul className="plain">{slots.map((sl) => (
              <li key={sl.id} className="row session"><span><strong>{slotTime(sl)}</strong>{sl.location ? ` · ${sl.location}` : ''}{sl.batchCode ? <span className="muted"> · {t('batch {code}', { code: sl.batchCode })}</span> : null}<br /><span className="muted">{sl.seatsLeft > 0 ? (sl.seatsLeft > 1 ? t('{n} seats left', { n: sl.seatsLeft }) : t('1 seat left')) : t('Full')}</span></span>
                <button disabled={!lab.eligibility.eligible || sl.seatsLeft < 1 || busy === sl.id} title={!lab.eligibility.eligible ? why.join(' ') : undefined} onClick={() => void run(sl.id, () => api.post(`/v1/labs/slots/${sl.id}/book`, {}, idempotencyKey()), t('Booked. You will get a reminder with the time and place.'))}>{t('Book')}</button></li>))}</ul>)}
          {!lab.eligibility.eligible && <p className="muted">{why.join(' ')}</p>}
        </Card>)}

      {b && !lab.completed && (
        <Card title={t('Your booking')} actions={<Badge tone={b.status === 'ATTENDED' ? 'ok' : 'warn'}>{b.status === 'ATTENDED' ? t('Attended') : t('Booked')}</Badge>}>
          {b.slot ? <p><strong>{slotTime(b.slot)}</strong>{b.slot.location ? ` · ${b.slot.location}` : ''}</p> : <p>{t('Your session is booked.')}</p>}
          {b.status === 'BOOKED' && (<>
            <Attend slot={b.slot} onDone={() => load()} />
            <button className="link" disabled={busy === b.id} onClick={() => void run(b.id, () => api.post(`/v1/labs/bookings/${b.id}/cancel`), t('Booking cancelled.'))}>{t('Cancel this booking')}</button>
            <p className="muted">{t('Bookings can only be cancelled up to a set number of hours before the session; if it is too late, the reason is shown.')}</p></>)}
          {b.status === 'ATTENDED' && <p className="note ok" role="status">{t('Your attendance is recorded.')}</p>}
        </Card>)}

      {b?.status === 'ATTENDED' && lab.requireEvidence && !lab.completed && <Evidence bookingId={b.id} submitted={b.evidenceSubmitted} onDone={() => load()} />}
      {lab.completed && <Card title={t('Completed')}><p className="note ok" role="status">{t('You have completed this lab.')}</p></Card>}
    </div>
  );
}

/** Check-in: the coordinator shows a rotating code (QR). The learner scans it with the in-app camera, opens the QR link from a phone camera, or types it. */
export function Attend({ slot, onDone, initialToken = '' }: { slot?: { startsAt: string; endsAt: string }; onDone: () => void | Promise<void>; initialToken?: string }) {
  const t = useT(); const [raw, setRaw] = useState(initialToken); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null); const [ok, setOk] = useState(false); const [scanning, setScanning] = useState(false);
  const win = slot ? attendanceWindow(slot) : null;
  const submit = async (value = raw) => { setBusy(true); setError(null); try { await api.post('/v1/labs/attendance', { token: tokenFromInput(value) }); setOk(true); await onDone(); } catch (e) { setError(e); } finally { setBusy(false); } };
  const scanned = (text: string) => { setScanning(false); setRaw(text); if (tokenFromInput(text) && (win ? win.open : true)) void submit(text); };
  if (ok) return <p className="note ok" role="status">{t('Attendance recorded. Thank you.')}</p>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label={t('Check in')}>
      <h3>{t('Check in at the lab')}</h3>{win?.text && <p className="muted">{win.text}</p>}
      {scanning ? <QrScanner onResult={scanned} onCancel={() => setScanning(false)} /> : cameraSupported() && <p><button type="button" onClick={() => setScanning(true)} disabled={busy || (win ? !win.open : false)}>{t('Scan the QR code')}</button></p>}
      <label htmlFor="att-code">{t('Check-in code (or the link from the QR code)')}</label><input id="att-code" value={raw} autoComplete="off" onChange={(e) => setRaw(e.target.value)} />
      <ErrorNote error={error} /><button type="submit" disabled={busy || !tokenFromInput(raw) || (win ? !win.open : false)}>{busy ? t('Checking in…') : t('Check in')}</button>
    </form>
  );
}

function Evidence({ bookingId, submitted, onDone }: { bookingId: string; submitted: boolean; onDone: () => void | Promise<void> }) {
  const t = useT(); const [files, setFiles] = useState<File[]>([]); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState(submitted);
  const submit = async () => {
    setBusy(true); setError(null);
    try { const up: UploadedFile[] = []; for (const f of files) up.push(await api.upload<UploadedFile>(`/v1/labs/evidence/upload?name=${encodeURIComponent(f.name)}`, f)); await api.post(`/v1/labs/bookings/${bookingId}/evidence`, { files: up, ...(note.trim() && { note: note.trim() }) }, idempotencyKey()); setDone(true); await onDone(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  if (done) return <Card title={t('3. Evidence')}><p className="note ok" role="status">{t('Evidence submitted. Your lab will be marked complete once it is accepted.')}</p></Card>;
  return (
    <Card title={t('3. Upload your evidence')}>
      <p>{t('Upload photos or files showing the work you did (up to 5 files, 10 MB each).')}</p>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label htmlFor="ev-files">{t('Files')}</label><input id="ev-files" type="file" multiple accept={ALLOWED} onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 5))} />
        {files.length > 0 && <ul aria-label={t('Selected files')}>{files.map((f) => <li key={f.name}>{f.name} <span className="muted">({Math.round(f.size / 1024)} KB)</span>{f.size > 10 * 1024 * 1024 && <span className="note error"> {t('too large')}</span>}</li>)}</ul>}
        <label htmlFor="ev-note">{t('Note (optional)')}</label><textarea id="ev-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        <ErrorNote error={error} /><button type="submit" disabled={busy || !files.length || files.some((f) => f.size > 10 * 1024 * 1024)}>{busy ? t('Uploading…') : t('Submit evidence')}</button>
      </form>
    </Card>
  );
}
