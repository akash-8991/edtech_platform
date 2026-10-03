import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Completion, EntitlementSummary } from '../api/types';
import { Badge, Card, Progress, Hold } from '../components/ui';
import { useT } from '../lib/i18n';

export default function CompletionPage() {
  const t = useT();
  const [c, setC] = useState<Completion | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { (async () => { try { const ents = await api.get<EntitlementSummary[]>('/v1/me/entitlements'); const e = ents.find((x) => x.learningAccess) ?? ents[0]; if (e) setC(await api.get<Completion>(`/v1/me/completion?entitlementId=${e.id}`)); else setError(new Error('none')); } catch (e) { setError(e); } })(); }, []);
  if (error || !c) return <Hold title={t('Programme completion')} error={error} what={t('Loading your completion status')} />;
  return (
    <div><h1>{t('Programme completion')}</h1>
      {c.programmeComplete && <p className="note ok" role="status">{t('You have met every requirement. Certificates are issued by the institute after verification.')}</p>}
      <Card title={t('Topics')} actions={<Badge tone={c.topics.complete ? 'ok' : 'warn'}>{c.topics.complete ? t('Complete') : t('In progress')}</Badge>}><Progress value={c.topics.percent} label={t('Topics')} /><p>{t('{n}% of required topics complete.', { n: c.topics.percent })}</p></Card>
      <Card title={t('Labs')} actions={<Badge tone={c.labs.complete ? 'ok' : 'warn'}>{c.labs.complete ? t('Complete') : t('Outstanding')}</Badge>}>{c.labs.complete ? <p>{t('All required labs are complete.')}</p> : <p>{t('Still to do: {list}.', { list: c.labs.outstanding.join(', ') })} <Link to="/labs">{t('Go to labs')}</Link></p>}</Card>
      <Card title={t('Exams')}>{c.exams.length ? <ul className="plain">{c.exams.map((e) => <li key={e.code} className="row"><span>{e.code}</span><Badge tone={e.passed ? 'ok' : 'warn'}>{e.passed ? t('Passed') : t('Not passed yet')}</Badge></li>)}</ul> : <p>{t('No exams for this programme.')}</p>}<Link to="/exams">{t('Go to exams')}</Link></Card>
    </div>
  );
}
