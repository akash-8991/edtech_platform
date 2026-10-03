import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { Doubt, EntitlementSummary } from '../api/types';
import { idempotencyKey } from '../lib/format';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { fmtDateTime, mark, tr, useT } from '../lib/i18n';

const CATEGORIES = ['CONTENT', 'TECHNICAL', 'ASSIGNMENT', 'EXAM', 'OTHER'];
const CAT_LABEL: Record<string, string> = { CONTENT: mark('Course content'), TECHNICAL: mark('Technical problem'), ASSIGNMENT: mark('Assignment'), EXAM: mark('Exam'), OTHER: mark('Something else') };
const STATUS_LABEL: Record<string, string> = { RESOLVED: mark('resolved'), OPEN: mark('open'), IN_PROGRESS: mark('in progress'), ASSIGNED: mark('assigned'), WAITING_LEARNER: mark('waiting for you'), REOPENED: mark('reopened') };

export default function Doubts() {
  const t = useT(); const [items, setItems] = useState<Doubt[] | null>(null); const [ents, setEnts] = useState<EntitlementSummary[]>([]); const [error, setError] = useState<unknown>(null);
  const [subject, setSubject] = useState(''); const [body, setBody] = useState(''); const [category, setCategory] = useState('CONTENT'); const [entId, setEntId] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => api.get<Doubt[]>('/v1/me/doubts').then(setItems).catch(setError);
  useEffect(() => { void load(); api.get<EntitlementSummary[]>('/v1/me/entitlements').then((e) => { const ok = e.filter((x) => x.learningAccess); setEnts(ok); setEntId(ok[0]?.id ?? ''); }).catch(setError); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api.post('/v1/doubts', { entitlementId: entId, subject: subject.trim(), body: body.trim(), category }, idempotencyKey()); setSubject(''); setBody(''); await load(); }
    catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <div>
      <h1>{t('Ask a teacher')}</h1>
      <Card title={t('New question')}>
        {!ents.length ? <p className="muted">{t('You need an active course to ask a teacher.')}</p> : (
          <form onSubmit={submit}>
            {ents.length > 1 && <><label htmlFor="d-ent">{t('Course')}</label><select id="d-ent" value={entId} onChange={(e) => setEntId(e.target.value)}>{ents.map((x) => <option key={x.id} value={x.id}>{x.id.slice(0, 8)}</option>)}</select></>}
            <label htmlFor="d-cat">{t('Category')}</label><select id="d-cat" value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{t(CAT_LABEL[c])}</option>)}</select>
            <label htmlFor="d-sub">{t('Subject')}</label><input id="d-sub" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
            <label htmlFor="d-body">{t('Your question')}</label><textarea id="d-body" rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
            <ErrorNote error={error} />
            <button type="submit" disabled={busy || !subject.trim() || !body.trim()}>{t('Send to a teacher')}</button>
          </form>)}
      </Card>
      <h2>{t('My questions')}</h2>
      {!items ? <Loading /> : !items.length ? <p className="muted">{t('You have not asked anything yet.')}</p> : <ul className="plain">{items.map((d) => <li key={d.id}><Card title={d.subject} actions={<Badge tone={d.status === 'RESOLVED' ? 'ok' : 'warn'}>{tr(STATUS_LABEL[d.status] ?? d.status.toLowerCase().replace(/_/g, ' '))}</Badge>}><p className="muted">{fmtDateTime(d.createdAt)}</p></Card></li>)}</ul>}
    </div>
  );
}
