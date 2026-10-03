import { useEffect, useRef, type ReactNode } from 'react';
import { messageFor } from '../api/client';
import { tr } from '../lib/i18n';

export function ErrorNote({ error }: { error: unknown }) { return error ? <p role="alert" className="note error">{messageFor(error)}</p> : null; }
export function Loading({ what }: { what?: string }) { return <p role="status" aria-live="polite" className="muted">{what ?? tr('Loading')}…</p>; }
/** Shown when a screen is drawn from what was saved on this device because the network could not be reached. */
export function StaleNote({ show }: { show: boolean }) { return show ? <p className="note warn" role="status">{tr('You are offline: this is what was saved on this device. Some details may be out of date.')}</p> : null; }
export function Card({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return <section className="card">{(title || actions) && <header className="card-head">{title && <h2>{title}</h2>}{actions}</header>}<div className="card-body">{children}</div></section>;
}
export function Progress({ value, label }: { value: number; label: string }) {
  return <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}><span style={{ width: `${value}%` }} /></div>;
}
export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'muted'; children: ReactNode }) { return <span className={`badge ${tone}`}>{children}</span>; }

/** A page that is still loading or failed to load: it keeps its heading, so every state of every page has one level-one heading. */
export function Hold({ title, error, what }: { title: string; error: unknown; what?: string }) { return <div><h1>{title}</h1>{error ? <ErrorNote error={error} /> : <Loading what={what} />}</div>; }

/**
 * A dialog that behaves like one for keyboard and screen-reader users: focus moves inside, Tab and Shift+Tab stay inside, Escape closes it
 * (when closing is allowed), and focus goes back to where it was when it closes.
 */
export function Modal({ labelledBy, onEscape, children }: { labelledBy: string; onEscape?: () => void; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null); const esc = useRef(onEscape); esc.current = onEscape;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null; const node = body.current!;
    const inside = () => [...node.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter((e) => !(e as HTMLButtonElement).disabled);
    if (!node.contains(document.activeElement)) (inside()[0] ?? node).focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && esc.current) { e.preventDefault(); esc.current(); return; }
      if (e.key !== 'Tab') return; const f = inside(); if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if (before && document.contains(before)) before.focus(); };
  }, []);
  return <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy}><div className="modal-body" ref={body} tabIndex={-1}>{children}</div></div>;
}
