import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { FaqRow } from '../api/types';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { faqStatusLabel, langName, reasonError } from '../lib/doubts';

/** Answers teachers propose for reuse. A second person approves them; approved ones feed the AI tutor and the topic's help list. */
export function Faq({ canReview, canTicket }: { canReview: boolean; canTicket: boolean }) {
  const [status, setStatus] = useState('DRAFT'); const [rows, setRows] = useState<FaqRow[] | null>(null); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState<string | null>(null);
  const load = useCallback(async (clear = true) => { try { setRows(await api.get<FaqRow[]>(`/v1/faq?status=${status}`)); if (clear) setError(null); } catch (e) { setError(e); } }, [status]);
  useEffect(() => { setRows(null); void load(); }, [load]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); setDone(null); try { await fn(); setDone(ok); await load(false); return true; } catch (e) { setError(e); await load(false); return false; } };
  return (
    <>
      <label htmlFor="fq-st" className="inline">Show</label> <select id="fq-st" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>{['DRAFT', 'APPROVED', 'REJECTED', 'RETIRED'].map((s) => <option key={s} value={s}>{faqStatusLabel(s)}</option>)}</select>
      <ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}
      {!rows ? (!error && <Loading what="Loading answers" />) : !rows.length ? <Card><p>{status === 'DRAFT' ? 'Nothing is waiting for review.' : 'Nothing here.'}</p></Card> : (
        <ul className="plain">{rows.map((f) => (
          <li key={f.id}><Card title={f.question} actions={<><Badge tone={f.status === 'APPROVED' ? 'ok' : 'muted'}>{faqStatusLabel(f.status)}</Badge><Badge tone="muted">{f.kind === 'REMEDIATION' ? 'Topic help' : 'FAQ'} · {langName(f.language)}</Badge></>}>
            <p>{f.answer}</p>{f.reviewReason && <p className="muted">Reviewer's note: {f.reviewReason}</p>}
            {f.sourceTicketId && canTicket && <p className="muted"><Link to={`/staff/doubts/tickets/${f.sourceTicketId}`}>Came from a ticket</Link></p>}
            {canReview && f.status === 'DRAFT' && <Review onDecide={(d, r) => act(() => api.post(`/v1/faq/${f.id}/review`, { decision: d, ...(r ? { reason: r } : {}) }), d === 'APPROVE' ? 'Approved: it is now used by the tutor.' : 'Rejected.')} />}
            {canReview && f.status === 'APPROVED' && <Retire onRetire={(r) => act(() => api.post(`/v1/faq/${f.id}/retire`, { reason: r }), 'Retired: the tutor no longer uses it.')} />}
          </Card></li>))}</ul>)}
    </>
  );
}

function Review({ onDecide }: { onDecide: (d: 'APPROVE' | 'REJECT', reason?: string) => Promise<boolean> }) {
  const [rej, setRej] = useState(false); const [reason, setReason] = useState(''); const [problem, setProblem] = useState<string | null>(null);
  if (!rej) return <div className="choices"><button onClick={() => void onDecide('APPROVE')}>Approve</button><button onClick={() => setRej(true)}>Reject…</button></div>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); const p = reasonError(reason); setProblem(p); if (!p) void onDecide('REJECT', reason.trim()); }} noValidate>
      <label htmlFor="fq-why">Why it is rejected (the teacher can read this)</label><textarea id="fq-why" value={reason} onChange={(e) => { setReason(e.target.value); setProblem(null); }} aria-invalid={!!problem} />{problem && <p role="alert" className="note error">{problem}</p>}
      <div className="choices"><button>Reject</button><button type="button" className="link" onClick={() => setRej(false)}>Cancel</button></div>
    </form>
  );
}

function Retire({ onRetire }: { onRetire: (r: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false); const [reason, setReason] = useState(''); const [problem, setProblem] = useState<string | null>(null);
  if (!open) return <button className="link" onClick={() => setOpen(true)}>Retire…</button>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); const p = reasonError(reason); setProblem(p); if (!p) void onRetire(reason.trim()); }} noValidate>
      <label htmlFor="fq-rt">Why it is being retired</label><textarea id="fq-rt" value={reason} onChange={(e) => { setReason(e.target.value); setProblem(null); }} />{problem && <p role="alert" className="note error">{problem}</p>}
      <div className="choices"><button>Retire</button><button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}
