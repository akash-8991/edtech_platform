import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { CatalogueItem, EntitlementSummary, Progress } from '../api/types';
import { Badge, Card, ErrorNote, Loading, Progress as Bar } from '../components/ui';

interface Row { ent: EntitlementSummary; title: string; percent: number | null }
const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export default function Courses() {
  const [rows, setRows] = useState<Row[] | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    (async () => {
      try {
        const [ents, cat] = await Promise.all([api.get<EntitlementSummary[]>('/v1/me/entitlements'), api.get<CatalogueItem[]>('/v1/catalogue').catch(() => [] as CatalogueItem[])]);
        const names = new Map(cat.map((c) => [c.versionId, c.title]));
        setRows(await Promise.all(ents.map(async (ent) => ({ ent, title: names.get(ent.versionId) ?? 'Your programme',
          percent: ent.learningAccess ? (await api.get<Progress>(`/v1/me/entitlements/${ent.id}/progress`).catch(() => null))?.percentComplete ?? null : null }))));
      } catch (e) { setError(e); }
    })();
  }, []);
  if (error) return <ErrorNote error={error} />;
  if (!rows) return <Loading what="Loading your courses" />;
  if (!rows.length) return <Card title="My courses"><p>You are not enrolled in a course yet. Once your application is approved it will appear here.</p></Card>;
  return (
    <div>
      <h1>My courses</h1>
      {rows.map(({ ent, title, percent }) => (
        <Card key={ent.id} title={ent.learningAccess ? <Link to={`/courses/${ent.id}`}>{title}</Link> : title} actions={<Badge tone={ent.learningAccess ? 'ok' : 'warn'}>{ent.effectiveStatus.toLowerCase()}</Badge>}>
          <p className="muted">Access {when(ent.startAt)} to {when(ent.endAt)}</p>
          {percent !== null ? <><Bar value={percent} label={`${title} progress`} /><p>{percent}% complete</p></> : !ent.learningAccess && <p>Learning is not available right now ({ent.effectiveStatus.toLowerCase()}). Contact support if this is unexpected.</p>}
        </Card>))}
    </div>
  );
}
