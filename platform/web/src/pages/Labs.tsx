import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { EntitlementSummary, LabActivity, Progress } from '../api/types';
import { Badge, Card, Hold } from '../components/ui';
import { blockers, labStatus, liveBooking, slotTime } from '../lib/labs';
import { useT } from '../lib/i18n';

export default function Labs() {
  const t = useT(); const [labs, setLabs] = useState<LabActivity[] | null>(null); const [titles, setTitles] = useState<Map<string, string>>(new Map()); const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    (async () => {
      try {
        const [l, ents] = await Promise.all([api.get<LabActivity[]>('/v1/me/labs'), api.get<EntitlementSummary[]>('/v1/me/entitlements')]);
        const names = new Map<string, string>(); await Promise.all(ents.filter((e) => e.learningAccess).map(async (e) => { (await api.get<Progress>(`/v1/me/entitlements/${e.id}/progress`).catch(() => null))?.topics.forEach((x) => names.set(x.topicId, x.title)); }));
        setTitles(names); setLabs(l);
      } catch (e) { setError(e); }
    })();
  }, []);
  if (error || !labs) return <Hold title={t('Labs')} error={error} what={t('Loading your labs')} />;
  const done = labs.filter((l) => l.completed).length;
  return (
    <div>
      <h1>{t('Labs')}</h1>
      {!labs.length ? <Card><p>{t('Your programme has no lab sessions.')}</p></Card> : (<>
        <p className="muted">{t('{a} of {n} completed. Mandatory labs must be completed before the final exam.', { a: done, n: labs.length })}</p>
        <ul className="plain">{labs.map((l) => { const s = labStatus(l); const b = liveBooking(l); const why = s.state === 'blocked' ? blockers(l, titles) : []; return (
          <li key={l.activityId}><Card title={<Link to={`/labs/${l.activityId}`}>{l.title}</Link>} actions={<><Badge tone={s.tone}>{s.label}</Badge>{l.mandatory && <Badge tone="muted">{t('Mandatory')}</Badge>}</>}>
            {l.location && <p className="muted">{t('Location: {place}', { place: l.location })}</p>}
            {b?.slot && <p>{t('Your session:')} <strong>{slotTime(b.slot)}</strong>{b.slot.location ? ` · ${b.slot.location}` : ''}</p>}
            {why.length > 0 && <ul aria-label={t('What you need to do first')}>{why.map((w) => <li key={w}>{w}</li>)}</ul>}
          </Card></li>); })}</ul></>)}
    </div>
  );
}
