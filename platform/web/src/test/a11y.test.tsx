import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Link, Route, Routes } from 'react-router-dom';
import { useState } from 'react';
import { RouteAnnouncer } from '../components/RouteAnnouncer';
import { Modal } from '../components/ui';
import { VideoPlayer } from '../components/VideoPlayer';
import { PrefsProvider } from '../prefs';
import { documentTitle, routeTitle } from '../lib/titles';
import type { Playback } from '../api/types';

// ---- colour contrast of the design tokens (WCAG 1.4.3 text 4.5:1, 1.4.11 non-text and focus 3:1), light and dark ----------------------------
const css = readFileSync('src/styles.css', 'utf8');
const tokens = (block: string) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
const light = tokens(css.match(/:root\s*\{([^}]*)\}/)![1]); const dark = { ...light, ...tokens(css.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)![1]) };
const lum = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const TEXT_PAIRS: [string, string][] = [['text', 'bg'], ['text', 'surface'], ['muted', 'bg'], ['muted', 'surface'], ['text', 'border'], ['accent', 'bg'], ['accent', 'surface'], ['accent-text', 'accent'], ['ok', 'ok-bg'], ['warn', 'warn-bg'], ['err', 'err-bg'], ['err', 'surface']];
describe('design tokens meet WCAG contrast', () => {
  for (const [name, t] of [['light', light], ['dark', dark]] as const) {
    it(`${name} theme: text pairs reach 4.5:1 and the focus ring reaches 3:1 on every surface`, () => {
      for (const [fg, bg] of TEXT_PAIRS) expect(ratio(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const bg of ['bg', 'surface', 'ok-bg', 'warn-bg', 'err-bg']) expect(ratio(t.focus, t[bg]), `focus ring on ${bg}`).toBeGreaterThanOrEqual(3);
    });
  }
});

// ---- page titles and page-change announcements ---------------------------------------------------------------------------------------------
describe('page titles', () => {
  it('names every page, with ids in the path ignored, and falls back to the app name', () => {
    expect(routeTitle('/')).toBe('My courses'); expect(routeTitle('/courses/abc/topics/def')).toBe('Topic'); expect(routeTitle('/staff/doubts/tickets/1234')).toBe('Ticket'); expect(routeTitle('/staff/examops/exams/e1/report')).toBe('Exam results report'); expect(routeTitle('/staff/users/')).toBe('People');
    expect(documentTitle('/grades')).toBe('Assignment grades · Learning Portal'); expect(routeTitle('/nowhere')).toBe('Learning Portal'); expect(documentTitle('/nowhere')).toBe('Learning Portal');
    const abs = (prefix: string, src: string) => [...readFileSync(src, 'utf8').matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '*' && p !== 'staff').map((p) => (p.startsWith('/') ? p : prefix + p).replace(/:\w+/g, 'x1'));
    const paths = [...abs('/', 'src/App.tsx'), ...abs('/staff/', 'src/staff/StaffRoutes.tsx')].filter((p) => p !== '/');
    expect(paths.length).toBeGreaterThan(40); for (const p of paths) expect(routeTitle(p), `a title for ${p}`).not.toBe('Learning Portal');
  });
});
describe('RouteAnnouncer', () => {
  const Shell = () => <><nav><Link to="/grades">Go to grades</Link></nav><RouteAnnouncer /><main id="main" tabIndex={-1}><Routes><Route path="/" element={<h1>Home</h1>} /><Route path="/grades" element={<h1>Grades</h1>} /></Routes></main></>;
  it('sets the tab title, says the new page politely, and moves focus to the content after a page change, but not on first load', async () => {
    render(<MemoryRouter initialEntries={['/']}><Shell /></MemoryRouter>); expect(document.title).toBe('My courses · Learning Portal'); expect(document.activeElement).toBe(document.body); expect(screen.getByRole('status')).toHaveTextContent('');
    await userEvent.click(screen.getByRole('link', { name: 'Go to grades' })); expect(document.title).toBe('Assignment grades · Learning Portal'); expect(screen.getByRole('status')).toHaveTextContent('Assignment grades, page loaded'); expect(document.activeElement).toBe(document.getElementById('main'));
  });
});

// ---- dialogs ---------------------------------------------------------------------------------------------------------------------------------
describe('Modal', () => {
  const Host = ({ onEsc }: { onEsc?: () => void }) => { const [open, setOpen] = useState(false); return <><button onClick={() => setOpen(true)}>Open</button>{open && <Modal labelledBy="t" onEscape={onEsc ? () => { onEsc(); setOpen(false); } : undefined}><h3 id="t">Sure?</h3><button>First</button><button>Last</button></Modal>}</>; };
  it('moves focus in, keeps Tab inside, closes on Escape, and gives focus back to what opened it', async () => {
    const esc = vi.fn(); render(<Host onEsc={esc} />); const opener = screen.getByRole('button', { name: 'Open' }); await userEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'Sure?' })).toBeInTheDocument(); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
    await userEvent.tab(); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Last' })); await userEvent.tab(); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' })); // wraps, never reaches the page behind
    await userEvent.tab({ shift: true }); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Last' }));
    await userEvent.keyboard('{Escape}'); expect(esc).toHaveBeenCalled(); expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(opener);
  });
  it('ignores Escape when closing is not allowed (a question the learner must answer)', async () => {
    render(<Host />); await userEvent.click(screen.getByRole('button', { name: 'Open' })); await userEvent.keyboard('{Escape}'); expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

// ---- captions ----------------------------------------------------------------------------------------------------------------------------------
describe('video captions', () => {
  const pb = (streams: Playback['streams'], mode: Playback['mode'] = 'normal'): Playback => ({ assetId: 'a1', language: 'en', durationSec: 60, mode, streams, interactions: [], resume: { sec: 0 } });
  const video = { label: '360p', mime: 'video/mp4', url: '/v/1' };
  it('adds a captions track on by default, in the video\'s language, when captions exist; says so plainly when they do not', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('transcript text')));
    const { container, unmount } = render(<PrefsProvider><VideoPlayer topicId="t" playback={pb([video, { label: 'captions', mime: 'text/vtt; charset=utf-8', url: '/c/1' }, { label: 'transcript', mime: 'text/plain', url: '/t/1' }])} onProgress={() => undefined} /></PrefsProvider>);
    const track = container.querySelector('track')!; expect(track).toHaveAttribute('kind', 'captions'); expect(track).toHaveAttribute('src', '/c/1'); expect(track).toHaveAttribute('srclang', 'en'); expect(track.hasAttribute('default')).toBe(true); expect(screen.queryByText(/has no captions yet/)).toBeNull(); unmount();
    const b = render(<PrefsProvider><VideoPlayer topicId="t" playback={pb([video, { label: 'transcript', mime: 'text/plain', url: '/t/1' }])} onProgress={() => undefined} /></PrefsProvider>); expect(b.container.querySelector('track')).toBeNull(); expect(screen.getByText(/has no captions yet; the transcript is below/)).toBeInTheDocument();
  });
});
