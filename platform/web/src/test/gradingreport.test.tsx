import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import GradeChanges from '../staff/GradeChanges';
import { AuthProvider, useAuth } from '../auth';
import { api } from '../api/client';
import type { GradingReportData } from '../api/types';
import { age, backlogWarn, barHeights, biasText, money, pct, sampleNote, stateRows, versionText } from '../lib/gradingreport';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let calls: string[] = [];
const route = (map: Record<string, () => Response>) => vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => { const k = `${init?.method ?? 'GET'} ${String(u)}`; calls.push(k); const h = map[k]; return h ? h() : res(404, { message: `no route ${k}` }); }));
beforeEach(() => { calls = []; api.clear(); });
const signIn = (roles: string[]) => { api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); return { 'GET /v1/auth/me': () => res(200, { id: 'me', email: 's@x.test', name: 'Sam', language: 'en', roles, mfaEnabled: true }) }; };
const Gate = ({ children }: { children: JSX.Element }) => (useAuth().loading ? <p>loading</p> : children);
const mount = () => render(<MemoryRouter initialEntries={['/staff/gradechanges']}><AuthProvider><Gate><Routes><Route path="/staff/gradechanges" element={<GradeChanges />} /></Routes></Gate></AuthProvider></MemoryRouter>);
const report = (o: Partial<GradingReportData> = {}): GradingReportData => ({ since: '2030-01-01T00:00:00Z', submissions: 40, byState: { PENDING_AI: 2, MODERATION_REQUIRED: 3, GRADED: 20, APPEALED: 1, FINAL: 14 }, moderationRate: 0.25, moderationReasons: { low_confidence: 6, borderline: 3, 'integrity:similarity': 1 },
  aiHumanAgreement: { pairs: 12, tolerancePct: 10, agreementRate: 0.75, meanAbsDiffPct: 6.5, humanMinusAiBiasPct: 3.2, perDimensionMAEPct: { correctness: 5, clarity_of_writing: 8 } }, appeals: { appealed: 4, rate: 0.1, overturned: 1, overturnRate: 0.25 }, integrity: { flaggedSubmissions: 2, confirmedConcerns: 1, cleared: 1 },
  scoreDistribution: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ range: `${i * 10}-${i === 9 ? 100 : i * 10 + 9}`, count: i === 7 ? 10 : i })), avgAiConfidence: 0.82, graderVersions: { 'claude@prompt3': 38 }, costUsd: 1.2345, backlog: { pendingAi: 2, oldestPendingMinutes: 90, openModeration: 3, oldestModerationMinutes: 3000 }, ...o });
const PROGS = [{ id: 'p', code: 'AI', title: 'AI', discipline: 'x', versions: [{ id: 'v1', version: 1, state: 'PUBLISHED' }, { id: 'v2', version: 2, state: 'DRAFT' }] }];

describe('grading report helpers', () => {
  it('words the figures plainly', () => {
    expect(pct(0.256)).toBe('26%'); expect(pct(null)).toBe('n/a'); expect(age(30)).toBe('30 min'); expect(age(300)).toBe('5 h'); expect(age(5000)).toBe('3 days'); expect(money(0.0123)).toBe('$0.0123'); expect(money(12.5)).toBe('$12.50');
    expect(biasText(null)).toMatch(/No pairs/); expect(biasText(0.4)).toMatch(/about the same/); expect(biasText(4)).toMatch(/4 points higher.*too hard/); expect(biasText(-4)).toMatch(/4 points lower.*too leniently/);
    expect(sampleNote(0)).toBeNull(); expect(sampleNote(5)).toMatch(/Only 5/); expect(sampleNote(30)).toBeNull(); expect(barHeights([{ count: 0 }, { count: 5 }, { count: 10 }])).toEqual([0, 50, 100]); expect(barHeights([{ count: 0 }])).toEqual([0]);
    expect(stateRows({ byState: { GRADED: 2 } })).toEqual([{ label: 'Graded (learner can appeal)', n: 2 }]); expect(backlogWarn({ pendingAi: 0, oldestPendingMinutes: 0, openModeration: 0, oldestModerationMinutes: 0 })).toBe(false); expect(versionText('claude@prompt3')).toBe('claude, prompt version 3'); expect(versionText('null@promptnull')).toBe('unknown model, prompt version ?');
  });
});

describe('grading report tab', () => {
  it('shows the figures, the chart with its table, agreement and reasons in words', async () => {
    route({ ...signIn(['ASSESSMENT_ADMIN']), 'GET /v1/authoring/programmes': () => res(403, { message: 'no' }), 'GET /v1/grading/overrides?status=PENDING': () => res(200, []), 'GET /v1/reports/grading?days=30': () => res(200, report()) });
    mount(); await userEvent.click(await screen.findByRole('button', { name: 'Grading report' }));
    expect(await screen.findByText('Work is waiting')).toBeInTheDocument(); expect(screen.getByText(/the oldest for 2 h/)).toBeInTheDocument(); expect(screen.getByText(/the oldest for 2 days/)).toBeInTheDocument(); expect(screen.getByRole('img', { name: /70-79%: 10/ })).toBeInTheDocument(); expect(screen.getByText('$1.23')).toBeInTheDocument();
    expect(screen.getByText(/Humans score 3.2 points higher than the AI/)).toBeInTheDocument(); expect(screen.getByText('75%', { selector: 'strong' })).toBeInTheDocument(); expect(screen.getByText('clarity of writing')).toBeInTheDocument(); expect(screen.getByText(/The AI was not confident enough/)).toBeInTheDocument(); expect(screen.getByText(/Integrity flag: similarity/)).toBeInTheDocument(); expect(screen.getByText(/claude, prompt version 3/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Course')).toBeNull(); // the role could not list courses, so no filter is offered
  });
  it('re-queries when the period or course changes, and says plainly when there is nothing', async () => {
    route({ ...signIn(['ACADEMIC_ADMIN']), 'GET /v1/authoring/programmes': () => res(200, PROGS), 'GET /v1/grading/overrides?status=PENDING': () => res(200, []), 'GET /v1/reports/grading?days=30': () => res(200, report()), 'GET /v1/reports/grading?days=7&versionId=v1': () => res(200, report({ submissions: 0, moderationRate: null, moderationReasons: {}, aiHumanAgreement: { pairs: 0, tolerancePct: 10, agreementRate: null, meanAbsDiffPct: null, humanMinusAiBiasPct: null, perDimensionMAEPct: {} }, graderVersions: {}, scoreDistribution: [], backlog: { pendingAi: 0, oldestPendingMinutes: 0, openModeration: 0, oldestModerationMinutes: 0 } })) });
    mount(); await userEvent.click(await screen.findByRole('button', { name: 'Grading report' })); const course = await screen.findByLabelText('Course'); expect(screen.getByRole('option', { name: 'AI, version 1' })).toBeInTheDocument(); expect(screen.queryByRole('option', { name: 'AI, version 2' })).toBeNull(); // drafts have no grading
    await userEvent.selectOptions(screen.getByLabelText('Period'), '7'); await userEvent.selectOptions(course, 'v1');
    expect(await screen.findByText('Nothing waiting')).toBeInTheDocument(); expect(screen.getByText(/No submission has been graded both by the AI and by a person/)).toBeInTheDocument(); expect(screen.getByText('No marks yet.')).toBeInTheDocument(); expect(screen.getByText('Nothing was sent to a person in this period.')).toBeInTheDocument(); expect(screen.getByText('No AI marking in this period.')).toBeInTheDocument();
    expect(calls).toContain('GET /v1/reports/grading?days=7&versionId=v1');
  });
  it('warns when very few submissions were graded both ways, and shows a failed load as an error', async () => {
    route({ ...signIn(['AUDITOR']), 'GET /v1/authoring/programmes': () => res(200, []), 'GET /v1/grading/overrides?status=PENDING': () => res(200, []), 'GET /v1/reports/grading?days=30': () => res(200, report({ aiHumanAgreement: { ...report().aiHumanAgreement, pairs: 3 } })) });
    const a = mount(); await userEvent.click(await screen.findByRole('button', { name: 'Grading report' })); expect(await screen.findByText(/Only 3 graded both ways/)).toBeInTheDocument(); a.unmount();
    route({ ...signIn(['AUDITOR']), 'GET /v1/authoring/programmes': () => res(200, []), 'GET /v1/grading/overrides?status=PENDING': () => res(200, []), 'GET /v1/reports/grading?days=30': () => res(500, { message: 'boom' }) }); mount(); await userEvent.click(await screen.findByRole('button', { name: 'Grading report' })); expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
