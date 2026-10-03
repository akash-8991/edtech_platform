import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { AiJob } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { AI_GEN, failureHelp, isFinished, jobLabel, jobTone, kindLabel, videoSteps } from '../lib/aigen';
import { canSee, hasAny } from '../lib/roles';

export default function AiJobPage({ pollMs = 3000 }: { pollMs?: number }) {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'content')) return <Navigate to="/staff" replace />;
  return <Page pollMs={pollMs} canCancel={hasAny(me?.roles, AI_GEN)} />;
}

const origin = () => (typeof window !== 'undefined' ? window.location.origin : '');

function Page({ pollMs, canCancel }: { pollMs: number; canCancel: boolean }) {
  const { jobId = '' } = useParams(); const [j, setJ] = useState<AiJob | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [copied, setCopied] = useState(false); const timer = useRef<ReturnType<typeof setTimeout>>();
  const load = useCallback(async () => {
    try { const x = await api.get<AiJob>(`/v1/ai/jobs/${jobId}`); setJ(x); setError(null); if (!isFinished(x.status)) timer.current = setTimeout(() => void load(), pollMs); } catch (e) { setError(e); }
  }, [jobId, pollMs]);
  useEffect(() => { setJ(null); void load(); return () => clearTimeout(timer.current); }, [load]);
  const cancel = async () => { setBusy(true); setError(null); try { await api.post(`/v1/ai/jobs/${jobId}/cancel`); clearTimeout(timer.current); await load(); } catch (e) { setError(e); } finally { setBusy(false); } };
  if (!j) return <div><p><Link to="/staff/content/generate">Back to AI generation</Link></p><h1>AI job</h1><ErrorNote error={error} />{!error && <Loading what="Loading the job" />}</div>;
  const help = failureHelp(j); const done = j.status === 'SUCCEEDED'; const r = j.result ?? {}; const versionId = r.versionId ?? j.versionId; const steps = j.topicId ? videoSteps(origin(), j.topicId) : null;
  const copy = async () => { try { await navigator.clipboard.writeText(steps!); setCopied(true); } catch { setCopied(false); } };
  return (
    <div>
      <p><Link to="/staff/content/generate">Back to AI generation</Link></p>
      <h1>{kindLabel(j.kind)} · AI job</h1>
      <p><Badge tone={jobTone(j.status)}>{jobLabel(j.status)}</Badge> <span className="muted">started {new Date(j.createdAt).toLocaleString()}{j.finishedAt ? `, finished ${new Date(j.finishedAt).toLocaleTimeString()}` : ''}{j.attempts > 1 ? ` · attempt ${j.attempts}` : ''}{j.costUsd ? ` · cost $${j.costUsd.toFixed(3)}` : ''}</span></p>
      <ErrorNote error={error} />
      {!isFinished(j.status) && <Card title="Working on it"><p role="status" aria-live="polite">{j.status === 'QUEUED' ? 'The job is waiting for a free worker. If it stays here for more than a minute, the background worker may not be running; tell a platform administrator.' : 'The AI is writing. This takes a few minutes; this page updates by itself.'}</p>
        {j.error && <p className="muted">Last problem, retrying: {j.error}</p>}{canCancel && j.status === 'QUEUED' && <button className="secondary" onClick={() => void cancel()} disabled={busy}>Cancel the job</button>}</Card>}
      {j.status === 'FAILED' && <Card title="It did not work"><p role="alert">{help}</p>{j.error && <details><summary>Technical detail</summary><p className="mono">{j.error}</p>{Array.isArray(r.detail) && <ul>{r.detail.slice(0, 8).map((f: { gate?: string; message?: string }, i: number) => <li key={i}>{f.gate ? `${f.gate}: ` : ''}{f.message ?? JSON.stringify(f)}</li>)}</ul>}</details>}</Card>}
      {j.status === 'CANCELLED' && <Card><p>The job was cancelled. Nothing was written.</p></Card>}
      {done && (
        <Card title="Your draft is ready" actions={versionId && <Link className="button" to={`/staff/content/versions/${versionId}`}>Open the draft</Link>}>
          {j.kind === 'CURRICULUM' && <p>{r.modules ?? '?'} modules and {r.topics ?? '?'} topics were written.</p>}{j.kind !== 'CURRICULUM' && <p>The topic's script, quiz and assignment were written into the draft.</p>}
          {typeof r.findings === 'number' && r.findings > 0 && <p className="note warn">{r.findings} quality {r.findings === 1 ? 'check needs' : 'checks need'} attention before this can go to review. They are listed on the draft.</p>}
          {Array.isArray(r.assumptions) && r.assumptions.length > 0 && <><h3>What the AI assumed (please check)</h3><ul>{r.assumptions.map((a: string, i: number) => <li key={i}>{a}</li>)}</ul></>}
          <h3>What happens next</h3>
          <ol><li>Open the draft, read it and edit what is wrong. The AI can be confidently wrong: check facts, examples and quiz answers.</li><li>Resolve the quality checks, then send it for faculty review and approval.</li><li>Make the lesson videos (below). A video needs its script approved first only if your institute says so.</li></ol>
        </Card>)}
      {done && steps && (
        <Card title="Turn this topic's script into video" actions={<button className="secondary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy commands'}</button>}>
          <p className="muted">Video is made by the video tool on a computer with ffmpeg and your Higgsfield/ElevenLabs keys, not in this window. The script above is the input. Sign in as the author to get <code>TOKEN</code> (see the video guide). The tool also makes captions and a transcript, and the platform builds the adaptive versions.</p>
          <pre className="transcript">{steps}</pre>
        </Card>)}
    </div>
  );
}
