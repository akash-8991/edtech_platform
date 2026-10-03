import type { ExamQuestion } from '../api/types';
import { useT } from '../lib/i18n';

export function ExamQuestionView({ q, n, total, value, onChange, flagged, onFlag }: { q: ExamQuestion; n: number; total: number; value: unknown; onChange: (v: unknown) => void; flagged: boolean; onFlag: () => void }) {
  const t = useT(); const id = `eq-${q.id}`; const multi = q.type === 'MCQ_MULTI';
  return (
    <section aria-labelledby={`${id}-t`} className="card">
      <header className="card-head"><h2 id={`${id}-t`}>{t('Question {n} of {total}', { n, total })} <span className="muted">({q.points === 1 ? t('1 mark') : t('{n} marks', { n: q.points })})</span></h2>
        <label className="inline"><input type="checkbox" checked={flagged} onChange={onFlag} /> {t('Flag for review')}</label></header>
      <p className="qtext">{q.text}</p>
      {q.type === 'NUMERIC' ? (<><label htmlFor={id}>{t('Your answer (a number)')}</label>
        <input id={id} type="number" step="any" inputMode="decimal" value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} /></>)
        : (<fieldset className="question"><legend className="muted">{multi ? t('Select all that apply') : t('Select one')}</legend>
          {q.options.map((o, idx) => { const checked = multi ? Array.isArray(value) && (value as number[]).includes(idx) : value === idx;
            return <label key={idx} className="choice"><input type={multi ? 'checkbox' : 'radio'} name={id} checked={checked} onChange={() => onChange(multi ? (checked ? (value as number[]).filter((x) => x !== idx) : [...((value as number[]) ?? []), idx].sort()) : idx)} /> {o}</label>; })}
        </fieldset>)}
    </section>
  );
}
export const isAnswered = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
