import { useRef, useState } from 'react';
import { api } from '../api/client';
import { ErrorNote } from './ui';
import { idempotencyKey } from '../lib/format';

const ALLOWED = '.pdf,.txt,.md,.png,.jpg,.jpeg,.zip,.ipynb,.py,.csv,.doc,.docx,.mp4,.mp3';

export function Assignment({ topicId, instructions, submitted, onDone }: { topicId: string; instructions?: string; submitted: boolean; onDone: () => void }) {
  const [text, setText] = useState(''); const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [done, setDone] = useState(submitted);
  const key = useRef(idempotencyKey());
  if (done) return <p className="note ok" role="status">Submitted. Your work is recorded and will be evaluated; you will be notified when there is feedback.</p>;
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const files = file ? [await api.upload(`/v1/topics/${topicId}/assignment/upload?name=${encodeURIComponent(file.name)}`, file)] : undefined;
      await api.post(`/v1/topics/${topicId}/assignment/submit`, { ...(text.trim() && { text: text.trim() }), ...(files && { files }) }, key.current);
      setDone(true); onDone();
    } catch (e) { setError(e); key.current = idempotencyKey(); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {instructions && <p>{instructions}</p>}
      <label htmlFor="as-text">Your answer</label>
      <textarea id="as-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
      <label htmlFor="as-file">Attach a file (optional)</label>
      <input id="as-file" type="file" accept={ALLOWED} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <ErrorNote error={error} />
      <button type="submit" disabled={busy || (!text.trim() && !file)}>{busy ? 'Submitting…' : 'Submit assignment'}</button>
      <p className="muted">You can submit once the quiz is passed. Submissions cannot be edited afterwards.</p>
    </form>
  );
}
