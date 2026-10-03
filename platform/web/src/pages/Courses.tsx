import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { cachedGet } from '../lib/offline/cache';
import type { CatalogueItem, EntitlementSummary, Progress } from '../api/types';
import { Badge, Card, Progress as Bar, Hold, StaleNote } from '../components/ui';
import { fmtDate, mark, tr, useT } from '../lib/i18n';

const statusWord = (s: string) => tr(({ ACTIVE: mark('active'), PAUSED: mark('paused'), EXPIRED: mark('expired'), REVOKED: mark('revoked') } as Record<string, string>)[s] ?? s.toLowerCase());
interface Row { ent: EntitlementSummary; title: string; percent: number | null }
const when = (iso: string) => fmtDate(iso);

export default function Courses() {
  const t = useT(); const [rows, setRows] = useState<Row[] | null>(null); const [error, setError] = useState<unknown>(null); const [stale, setStale] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const get = async <T,>(p: string) => { const r = await cachedGet<T>(p); if (r.stale) setStale(true); return r.data; };
        const [ents, cat] = await Promise.all([get<EntitlementSummary[]>('/v1/me/entitlements'), get<CatalogueItem[]>('/v1/catalogue').catch(() => [] as CatalogueItem[])]);
        const names = new Map(cat.map((c) => [c.versionId, c.title]));
        setRows(await Promise.all(ents.map(async (ent) => ({ ent, title: names.get(ent.versionId) ?? tr('Your programme'),
          percent: ent.learningAccess ? (await get<Progress>(`/v1/me/entitlements/${ent.id}/progress`).catch(() => null))?.percentComplete ?? null : null }))));
      } catch (e) { setError(e); }
    })();
  }, []);
  if (error || !rows) return <Hold title={t('My courses')} error={error} what={t('Loading your courses')} />;
  if (!rows.length) return <div><h1>{t('My courses')}</h1><Card><p>{t('You are not enrolled in a course yet. Once your application is approved it will appear here.')}</p></Card></div>;
  return (
    <div>
      <h1>{t('My courses')}</h1>
      <StaleNote show={stale} />
      {rows.map(({ ent, title, percent }) => (
        <Card key={ent.id} title={ent.learningAccess ? <Link to={`/courses/${ent.id}`}>{title}</Link> : title} actions={<Badge tone={ent.learningAccess ? 'ok' : 'warn'}>{statusWord(ent.effectiveStatus)}</Badge>}>
          <p className="muted">{t('Access {from} to {to}', { from: when(ent.startAt), to: when(ent.endAt) })}</p>
          {percent !== null ? <><Bar value={percent} label={t('{title} progress', { title })} /><p>{t('{n}% complete', { n: percent })}</p></> : !ent.learningAccess && <p>{t('Learning is not available right now ({status}). Contact support if this is unexpected.', { status: statusWord(ent.effectiveStatus) })}</p>}
        </Card>))}
    </div>
  );
}
