import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { EntitlementSummary, TutorAnswer } from '../api/types';
import { Card, ErrorNote } from '../components/ui';

interface Consent { purpose: string; granted: boolean; currentNoticeVersion: string; upToDate: boolean }
interface Turn { q: string; a: TutorAnswer }

/** Grounded tutor: answers only from your course material and says so when it cannot. */
export default function Tutor() {
  const [consent, setConsent] = useState<Consent | null>(null); const [ent, setEnt] = useState<EntitlementSummary | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]); const [q, setQ] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<Consent[]>('/v1/me/consents').then((c) => setConsent(c.find((x) => x.purpose === 'AI_TUTOR') ?? null)).catch(setError);
    api.get<EntitlementSummary[]>('/v1/me/entitlements').then((e) => setEnt(e.find((x) => x.learningAccess) ?? null)).catch(setError);
  }, []);
  const accept = async () => { try { const c = await api.request<Consent[]>('PUT', '/v1/me/consents', { body: { purpose: 'AI_TUTOR', granted: true, version: consent!.currentNoticeVersion } }); setConsent(c.find((x) => x.purpose === 'AI_TUTOR') ?? null); } catch (e) { setError(e); } };
  const ask = async (e: FormEvent) => {
    e.preventDefault(); if (!q.trim()) return; setBusy(true); setError(null);
    try { const a = await api.post<TutorAnswer>('/v1/tutor/ask', { question: q.trim(), ...(ent && { entitlementId: ent.id }), ...(turns.length && turns[turns.length - 1].a.conversationId && { conversationId: turns[turns.length - 1].a.conversationId }) }); setTurns((t) => [...t, { q: q.trim(), a }]); setQ(''); }
    catch (err) { if (err instanceof ApiError && err.code === 'consent_required') setConsent((c) => c && { ...c, granted: false }); setError(err); } finally { setBusy(false); }
  };
  return (
    <div>
      <h1>AI tutor</h1>
      <p className="muted">The tutor answers only from your course material. If it cannot support an answer it says so and offers a teacher. It does not give answers to quiz, assignment or exam questions.</p>
      {consent && !consent.granted && (
        <Card title="Before you start"><p>Your questions are processed by an AI service and kept to improve your learning support, as described in the institute's privacy notice (version {consent.currentNoticeVersion}).</p>
          <button onClick={accept}>I understand and agree</button></Card>)}
      {(!consent || consent.granted) && (<>
        <ol className="plain" aria-live="polite">{turns.map((t, i) => (
          <li key={i}><Card title={t.q}><p>{t.a.answer}</p>
            {t.a.citations?.length ? <p className="muted">Based on: {t.a.citations.map((c) => c.title ?? c.topicId).join(', ')}</p> : null}
            {t.a.status && t.a.status !== 'ANSWERED' && <p className="note warn">I could not find a supported answer in your course. <Link to="/doubts">Ask a teacher</Link>.</p>}</Card></li>))}</ol>
        <form onSubmit={ask}><label htmlFor="tq">Your question</label><textarea id="tq" rows={3} value={q} maxLength={2000} onChange={(e) => setQ(e.target.value)} /><ErrorNote error={error} />
          <button type="submit" disabled={busy || q.trim().length < 3}>{busy ? 'Thinking…' : 'Ask'}</button></form></>)}
    </div>
  );
}
