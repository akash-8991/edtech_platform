import { useState } from 'react';
import { api } from '../api/client';
import type { QuizQuestion, QuizResult, QuizStart } from '../api/types';
import { ErrorNote } from './ui';
import { idempotencyKey } from '../lib/format';
import { useT } from '../lib/i18n';

/** Starts an attempt, renders the questions (no answer keys ever reach the browser), and submits once with a retry-safe key. */
export function Quiz({ topicId, remaining, onDone }: { topicId: string; remaining: number | null; onDone: () => void }) {
  const t = useT(); const [attempt, setAttempt] = useState<QuizStart | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<QuizResult | null>(null);
  const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(idempotencyKey);

  const start = async () => { setBusy(true); setError(null); setResult(null); setAnswers({}); try { setAttempt(await api.post<QuizStart>(`/v1/topics/${topicId}/quiz/start`)); setKey(idempotencyKey()); } catch (e) { setError(e); } finally { setBusy(false); } };
  const submit = async () => {
    if (!attempt) return; setBusy(true); setError(null);
    try { const r = await api.post<QuizResult>(`/v1/quiz-attempts/${attempt.attemptId}/submit`, { answers }, key); setResult(r); setAttempt(null); onDone(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  const answered = attempt ? attempt.questions.every((q) => answers[q.id] !== undefined && answers[q.id] !== '' && !(Array.isArray(answers[q.id]) && (answers[q.id] as unknown[]).length === 0)) : false;

  if (result) {
    return (
      <div aria-live="polite">
        <p className={`note ${result.passed ? 'ok' : 'warn'}`}>{result.passed ? t('Passed. Well done.') : t('Not passed this time.')} {typeof result.scorePercent === 'number' && t('Score: {n}%.', { n: Math.round(result.scorePercent) })}</p>
        {!result.passed && typeof result.attemptsRemaining === 'number' && result.attemptsRemaining > 0 && <button onClick={start} disabled={busy}>{t('Try again ({n} left)', { n: result.attemptsRemaining })}</button>}
        {!result.passed && result.attemptsRemaining === 0 && <p className="muted">{t('No attempts left. Ask your programme team if you need another.')}</p>}
      </div>
    );
  }
  if (!attempt) return (<div><ErrorNote error={error} /><button onClick={start} disabled={busy || remaining === 0}>{t('Start quiz')}</button>{remaining !== null && <p className="muted">{t('{n} attempt(s) remaining.', { n: remaining })}</p>}</div>);
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {attempt.questions.map((q, i) => <Question key={q.id} q={q} n={i + 1} value={answers[q.id]} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} />)}
      <ErrorNote error={error} />
      <button type="submit" disabled={busy || !answered}>{t('Submit answers')}</button>
      {!answered && <p className="muted">{t('Answer every question to submit.')}</p>}
    </form>
  );
}

function Question({ q, n, value, onChange }: { q: QuizQuestion; n: number; value: unknown; onChange: (v: unknown) => void }) {
  const t = useT(); const id = `q-${q.id}`;
  if (q.type === 'NUMERIC') return (
    <div className="question"><label htmlFor={id}>{n}. {q.text}</label>
      <input id={id} type="number" step="any" inputMode="decimal" value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} /></div>);
  const multi = q.type === 'MCQ_MULTI';
  return (
    <fieldset className="question"><legend>{n}. {q.text}{multi && <span className="muted"> ({t('select all that apply')})</span>}</legend>
      {(q.options ?? []).map((o, idx) => {
        const checked = multi ? Array.isArray(value) && (value as number[]).includes(idx) : value === idx;
        return (<label key={idx} className="choice"><input type={multi ? 'checkbox' : 'radio'} name={id} checked={checked}
          onChange={() => onChange(multi ? (checked ? (value as number[]).filter((x) => x !== idx) : [...((value as number[]) ?? []), idx]) : idx)} /> {o}</label>);
      })}
    </fieldset>);
}
