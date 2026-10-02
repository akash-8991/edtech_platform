import type { SignalKind } from '../api/types';

/**
 * Reports behaviour a human reviewer may care about (leaving the exam window, exiting full screen, copy/paste). These are SIGNALS, not
 * verdicts: the server records them and raises an incident for review only past thresholds. Each kind is throttled so one tab switch
 * (which fires both `blur` and `visibilitychange`) is one signal.
 */
export function watchSignals(report: (k: SignalKind) => void, doc: Document = document, win: Window = window, throttleMs = 2000): () => void {
  const last = new Map<SignalKind, number>();
  const fire = (k: SignalKind) => { const t = Date.now(); if (t - (last.get(k) ?? 0) < throttleMs) return; last.set(k, t); report(k); };
  const onVis = () => { if (doc.visibilityState === 'hidden') fire('FOCUS_LOST'); };
  const onBlur = () => fire('FOCUS_LOST');
  const onFs = () => { if (!doc.fullscreenElement) fire('FULLSCREEN_EXIT'); };
  const onCopy = () => fire('COPY'); const onPaste = () => fire('PASTE');
  doc.addEventListener('visibilitychange', onVis); win.addEventListener('blur', onBlur); doc.addEventListener('fullscreenchange', onFs); doc.addEventListener('copy', onCopy); doc.addEventListener('paste', onPaste);
  return () => { doc.removeEventListener('visibilitychange', onVis); win.removeEventListener('blur', onBlur); doc.removeEventListener('fullscreenchange', onFs); doc.removeEventListener('copy', onCopy); doc.removeEventListener('paste', onPaste); };
}
