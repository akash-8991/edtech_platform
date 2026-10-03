import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { render, screen } from '@testing-library/react';
import { useState } from 'react';
import { HI } from '../i18n/hi';
import { chooseLang, fmtDate, LocaleProvider, localeOf, translate, useLocale, useT, type Lang } from '../lib/i18n';
import { routeTitle } from '../lib/titles';
import { describeState } from '../lib/grades';
import { describeRequest, friendlyDevice, typeLabel } from '../lib/privacy';
import { notificationText, NOTES } from '../lib/format';
import { attendanceWindow, blockers, labStatus, slotTime } from '../lib/labs';
import { messageFor, ApiError } from '../api/client';

/** Source files a learner sees. The staff console is English only and is deliberately not scanned. */
const FILES = [...readdirSync('src/pages').map((f) => `src/pages/${f}`), ...readdirSync('src/components').map((f) => `src/components/${f}`), 'src/App.tsx', 'src/auth.tsx', 'src/prefs.tsx', 'src/api/client.ts',
  ...['format', 'grades', 'labs', 'privacy', 'titles'].map((n) => `src/lib/${n}.ts`), ...readdirSync('src/lib/offline').map((f) => `src/lib/offline/${f}`)].filter((f) => /\.tsx?$/.test(f));
const CALL = /\b(?:t|tt|tr|mark)\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
const used = new Map<string, string>();
for (const f of FILES) for (const m of readFileSync(f, 'utf8').matchAll(CALL)) used.set(m[1].slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"'), f);
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

describe('Hindi translations', () => {
  it('cover every string a learner can see (add new strings to src/i18n/hi.json)', () => {
    expect(used.size).toBeGreaterThan(400);
    expect([...used.keys()].filter((k) => !HI[k])).toEqual([]);
  });
  it('contain nothing that is no longer used', () => { expect(Object.keys(HI).filter((k) => !used.has(k))).toEqual([]); });
  it('keep every {placeholder} and are real translations', () => {
    for (const [k, v] of Object.entries(HI)) { expect(holes(v), `placeholders of “${k}”`).toBe(holes(k)); expect(v.trim(), k).not.toBe(''); }
    const same = Object.entries(HI).filter(([k, v]) => k === v && /[a-z]{4}/i.test(k)).map(([k]) => k); expect(same).toEqual([]);
    expect(Object.values(HI).filter((v) => !/[ऀ-ॿ]/.test(v)).length).toBeLessThan(5); // Devanagari throughout (a few strings are only a placeholder or a number)
  });
  it('translate, fill placeholders, and fall back to English for an unknown string', () => {
    expect(translate('Exams', undefined, 'hi')).toBe('परीक्षाएँ'); expect(translate('Exams', undefined, 'en')).toBe('Exams');
    expect(translate('Check in: {title}', { title: 'Final' }, 'hi')).toBe('चेक इन: Final'); expect(translate('A brand new string', undefined, 'hi')).toBe('A brand new string'); expect(translate('{n} marks', { n: 3 }, 'en')).toBe('3 marks');
    expect(translate('Hello {name}', {}, 'en')).toBe('Hello {name}'); // a missing value is left visible rather than blank
  });
});

describe('language choice', () => {
  it('prefers the saved choice, then the account, then the browser', () => {
    expect(chooseLang('hi', 'en', ['en-US'])).toBe('hi'); expect(chooseLang(undefined, 'hi', ['en-US'])).toBe('hi'); expect(chooseLang(undefined, undefined, ['en-US', 'hi-IN'])).toBe('hi'); expect(chooseLang(undefined, undefined, ['fr'])).toBe('en'); expect(chooseLang('xx', 'yy', [])).toBe('en');
  });
  it('formats dates in the chosen language', () => {
    const d = '2030-03-05T10:00:00Z'; const When = () => <p>{fmtDate(d, { dateStyle: 'long' })}</p>; render(<LocaleProvider lang="hi"><When /></LocaleProvider>);
    expect(localeOf('hi')).toBe('hi-IN'); expect(screen.getByText(/मार्च/)).toBeInTheDocument();
  });
  it('switches the whole tree, the document language and the plain helpers together', async () => {
    const Page = () => { const t = useT(); const { lang, setLang } = useLocale(); return <div><h1>{t('My courses')}</h1><p>{describeState('GRADED').label}</p><button onClick={() => setLang(lang === 'en' ? 'hi' : 'en')}>switch</button></div>; };
    const Host = () => { const [l, setL] = useState<Lang>('en'); return <LocaleProvider lang={l} onChange={setL}><Page /></LocaleProvider>; };
    render(<Host />); expect(screen.getByRole('heading')).toHaveTextContent('My courses'); expect(document.documentElement.lang).toBe('en');
    screen.getByText('switch').click(); expect(await screen.findByRole('heading', { name: 'मेरे कोर्स' })).toBeInTheDocument(); expect(screen.getByText('ग्रेड मिल गया')).toBeInTheDocument(); expect(document.documentElement.lang).toBe('hi');
  });
});

describe('text that comes from helpers is translated at the moment it is shown', () => {
  const inHindi = <T,>(fn: () => T) => { let out!: T; render(<LocaleProvider lang="hi"><Probe fn={() => { out = fn(); }} /></LocaleProvider>); return out; };
  const Probe = ({ fn }: { fn: () => void }) => { fn(); return null; };
  it('page titles, notifications, grade states, privacy requests and lab states', () => {
    expect(inHindi(() => routeTitle('/exams'))).toBe('परीक्षाएँ'); expect(inHindi(() => routeTitle('/staff/users'))).toBe('People'); // staff console stays English
    for (const k of Object.keys(NOTES)) expect(inHindi(() => notificationText(k)), k).toMatch(/[ऀ-ॿ]/);
    for (const s of ['PENDING_AI', 'MODERATION_REQUIRED', 'APPEALED', 'GRADED', 'FINAL'] as const) expect(inHindi(() => describeState(s).label)).toMatch(/[ऀ-ॿ]/);
    for (const s of ['REQUESTED', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'BLOCKED']) expect(inHindi(() => describeRequest({ type: 'ERASURE', status: s, exportExpiresAt: null, decisionReason: null }).label)).toMatch(/[ऀ-ॿ]/);
    expect(inHindi(() => typeLabel('EXPORT'))).toBe('डेटा डाउनलोड'); expect(inHindi(() => friendlyDevice(null))).toBe('अज्ञात डिवाइस');
    expect(inHindi(() => messageFor(new ApiError(503, {})))).toMatch(/[ऀ-ॿ]/); expect(inHindi(() => messageFor(new TypeError('x')))).toMatch(/[ऀ-ॿ]/);
    const lab = { activityId: 'a', code: 'L', title: 'T', mandatory: true, safetyText: '', safetyHash: '', requireEvidence: false, completed: false, bookings: [], eligibility: { eligible: false, missingPrerequisiteTopics: ['t1'], safetyAcknowledged: false } };
    expect(inHindi(() => labStatus(lab).label)).toBe('अभी तैयार नहीं'); expect(inHindi(() => blockers(lab, new Map([['t1', 'Sensors']])))[0]).toBe('पहले विषय "Sensors" पूरा करें।');
    expect(inHindi(() => attendanceWindow({ startsAt: '2000-01-01T00:00:00Z', endsAt: '2000-01-01T01:00:00Z' }).text)).toBe('यह सत्र समाप्त हो चुका है।'); expect(inHindi(() => slotTime({ startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T12:00:00Z' }))).toMatch(/से/);
  });
});
