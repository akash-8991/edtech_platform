import type { ReactNode } from 'react';
import { messageFor } from '../api/client';

export function ErrorNote({ error }: { error: unknown }) { return error ? <p role="alert" className="note error">{messageFor(error)}</p> : null; }
export function Loading({ what = 'Loading' }: { what?: string }) { return <p role="status" aria-live="polite" className="muted">{what}…</p>; }
export function Card({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return <section className="card">{(title || actions) && <header className="card-head">{title && <h2>{title}</h2>}{actions}</header>}{children}</section>;
}
export function Progress({ value, label }: { value: number; label: string }) {
  return <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}><span style={{ width: `${value}%` }} /></div>;
}
export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'muted'; children: ReactNode }) { return <span className={`badge ${tone}`}>{children}</span>; }
