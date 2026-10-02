import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Moderation from '../staff/Moderation';
import ModerationCase from '../staff/ModerationCase';
import { AuthProvider, useAuth } from '../auth';
import type { ReactNode } from 'react';
import { api } from '../api/client';
import { ageText, canConfirmAi, describeReason, estimatePercent, kindLabel, scoreError, validateDecision, type DecisionInput } from '../lib/moderation';
import type { CaseFile, RubricDim } from '../api/types';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let calls: { method: string; url: string; body: any }[] = [];
type H = (c: { body: any; n: number }) => Response;
const route = (map: Record<string, H>) => { const counts: Record<string, number> = {}; vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => {
  const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined; calls.push({ method, url, body });
  const k = `${method} ${url}`; counts[k] = (counts[k] ?? 0) + 1; const h = map[k]; return h ? h({ body, n: counts[k] }) : res(404, { message: `no route ${k}` }); })); };
beforeEach(() => { calls = []; api.clear(); });
/** The real app shows pages only after the signed-in user is known (StaffShell); tests do the same. */
const Ready = ({ children }: { children: ReactNode }) => { const { loading } = useAuth(); return loading ? null : <>{children}</>; };
const asRole = (roles: string[], id = 'me-1') => { api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); return { 'GET /v1/auth/me': () => res(200, { id, email: 'r@x.test', name: 'Rita Reviewer', language: 'en', roles, mfaEnabled: true }) } as Record<string, H>; };

const DIMS: RubricDim[] = [{ id: 'correctness', name: 'Correctness', weight: 60, min: 0, max: 4, levels: [{ score: 0, descriptor: 'Missing or incorrect' }, { score: 4, descriptor: 'Excellent' }] }, { id: 'clarity', name: 'Clarity', weight: 40, min: 0, max: 4 }];
const rec = (o: any = {}) => ({ seq: 1, kind: 'AI', dimensions: [{ id: 'correctness', score: 3, max: 4, rationale: 'Mostly right', evidence: [{ quote: 'gating is enforced', location: 'text', verified: true }, { quote: 'invented line', location: 'text', verified: false }] }, { id: 'clarity', score: 2, max: 4, rationale: 'Some jargon' }], rawPercent: 65, latePenaltyPercent: 0, finalPercent: 65, passed: true, confidence: 0.55, flags: ['low_confidence'], feedback: 'Decent.', model: 'claude-x', at: '2026-10-02T10:00:00Z', ...o });
const file = (o: any = {}): CaseFile => ({ task: { id: 'T1', kind: 'BLOCKING', status: 'CLAIMED', reasons: ['low_confidence'], claimedById: 'me-1' }, learnerRef: '3f9a1c', attemptNo: 1, submittedAt: '2026-10-02T09:00:00Z', assignment: { instructions: 'Explain gating.' },
  policy: { dimensions: DIMS, passPercent: 60, appealWindowDays: 7 }, submission: { text: 'The platform gates progress on the server.', files: [{ name: 'notes.pdf', size: 2048 }], contentHash: 'abcdef0123456789abcdef', testResults: null }, state: 'MODERATION_REQUIRED', reasons: ['low_confidence'], records: [rec()], similarity: [], ...o });

describe('moderation helpers', () => {
  it('explains routing reasons in plain words and keeps unknown ones as written', () => {
    expect(describeReason('low_confidence')).toMatch(/not confident/); expect(describeReason('integrity:high_similarity')).toBe('Integrity flag: high similarity'); expect(describeReason('appeal: I included an example')).toBe("Learner's appeal: I included an example"); expect(describeReason('some_new_thing')).toBe('some new thing');
    expect(kindLabel('BLOCKING')).toBe('Needs a grade'); expect(kindLabel('APPEAL')).toBe('Appeal'); expect(ageText(5)).toBe('5 min'); expect(ageText(180)).toBe('3 h'); expect(ageText(4320)).toBe('3 days');
  });
  it('previews the score with the server\'s weighted formula', () => {
    expect(estimatePercent(DIMS, { correctness: 3, clarity: 2 })).toBe(65); expect(estimatePercent(DIMS, { correctness: 4, clarity: 4 })).toBe(100); expect(estimatePercent(DIMS, {})).toBe(0); expect(estimatePercent(DIMS, { correctness: 9, clarity: -3 })).toBe(60); // clamped to the rubric range
    expect(estimatePercent([{ id: 'a', name: 'A', weight: 30, min: 0, max: 4 }, { id: 'b', name: 'B', weight: 30, min: 1, max: 5 }], { a: 2, b: 3 })).toBe(50); // weights are normalised, min is respected
  });
  it('accepts only scores the server will accept', () => {
    const d = DIMS[0]; expect(scoreError(d, '')).toMatch(/Enter/); expect(scoreError(d, 'x')).toMatch(/number/); expect(scoreError(d, '5')).toMatch(/Between 0 and 4/); expect(scoreError(d, '-1')).toMatch(/Between/); expect(scoreError(d, '2.3')).toMatch(/half-point/); expect(scoreError(d, '2.5')).toBeNull(); expect(scoreError(d, '0')).toBeNull();
  });
  it('checks a whole decision the way the server will, before sending it', () => {
    const base: DecisionInput = { scores: { correctness: '3', clarity: '2' }, feedback: '', reason: 'Reviewed', integrity: '', outcome: '', confirmAi: false };
    expect(validateDecision(file(), base)).toEqual([]); expect(validateDecision(file(), { ...base, reason: ' ' })[0]).toMatch(/reason/); expect(validateDecision(file(), { ...base, scores: { correctness: '3' } }).join()).toMatch(/Clarity/);
    const flagged = file({ reasons: ['integrity:high_similarity'] }); expect(validateDecision(flagged, base).join()).toMatch(/integrity flag/); expect(validateDecision(flagged, { ...base, integrity: 'CLEARED' })).toEqual([]);
    const appeal = file({ task: { ...file().task, kind: 'APPEAL' }, records: [rec({ kind: 'MODERATED', rawPercent: 65 })] }); expect(validateDecision(appeal, base).join()).toMatch(/upheld or adjusted/); expect(validateDecision(appeal, { ...base, outcome: 'UPHELD' })).toEqual([]);
    expect(validateDecision(appeal, { ...base, outcome: 'UPHELD', scores: { correctness: '4', clarity: '4' } }).join()).toMatch(/"Upheld" means the grade is unchanged/); expect(validateDecision(appeal, { ...base, outcome: 'ADJUSTED', scores: { correctness: '4', clarity: '4' } })).toEqual([]);
    expect(validateDecision(file(), { ...base, scores: {}, confirmAi: true })).toEqual([]); expect(canConfirmAi(file())).toBe(true); expect(canConfirmAi(file({ records: [rec({ kind: 'MODERATED' })] }))).toBe(false); expect(canConfirmAi(file({ records: [] }))).toBe(false);
  });
});

describe('queue', () => {
  const row = (o: any = {}) => ({ taskId: 'T1', kind: 'BLOCKING', status: 'OPEN', reasons: ['ai_unavailable', 'low_confidence'], ageMinutes: 125, submissionId: 'S1', learnerRef: '3f9a1c', aiPercent: null, claimedById: null, ...o });
  const queue = (_roles: string[]) => render(<MemoryRouter initialEntries={['/staff/moderation']}><AuthProvider><Ready><Routes><Route path="/staff/moderation" element={<Moderation />} /><Route path="/staff/moderation/:taskId" element={<p>CASE PAGE</p>} /><Route path="/staff" element={<p>STAFF HOME</p>} /></Routes></Ready></AuthProvider></MemoryRouter>);
  it('lists what needs a person with plain reasons and pseudonymous learner references', async () => {
    route({ ...asRole(['FACULTY_REVIEWER']), 'GET /v1/moderation/queue?status=OPEN': () => res(200, [row(), row({ taskId: 'T2', kind: 'APPEAL', reasons: ['appeal: please re-check'], learnerRef: 'aa11bb', aiPercent: 71 })]) }); queue(['FACULTY_REVIEWER']);
    expect(await screen.findByText('Submission 3f9a1c')).toBeInTheDocument(); expect(screen.getByText('The AI could not grade this (unavailable)')).toBeInTheDocument(); expect(screen.getAllByText(/waiting 2 h/)).toHaveLength(2); expect(screen.getByText("Learner's appeal: please re-check")).toBeInTheDocument(); expect(screen.getByText("AI's score: 71%")).toBeInTheDocument(); expect(screen.getAllByRole('button', { name: 'Claim and open' })).toHaveLength(2);
  });
  it('claims a task and opens its case file; a lost race shows the reason and refreshes', async () => {
    route({ ...asRole(['FACULTY_REVIEWER']), 'GET /v1/moderation/queue?status=OPEN': ({ n }) => res(200, n === 1 ? [row(), row({ taskId: 'T2' })] : [row({ taskId: 'T2' })]), 'POST /v1/moderation/tasks/T1/claim': () => res(409, { message: 'task already claimed or done' }), 'POST /v1/moderation/tasks/T2/claim': () => res(201, { ok: true }) });
    const u = userEvent.setup(); queue(['FACULTY_REVIEWER']); const btns = await screen.findAllByRole('button', { name: 'Claim and open' }); await u.click(btns[0]); expect(await screen.findByRole('alert')).toHaveTextContent('already claimed'); await waitFor(() => expect(screen.getAllByRole('button', { name: 'Claim and open' })).toHaveLength(1));
    await u.click(screen.getByRole('button', { name: 'Claim and open' })); expect(await screen.findByText('CASE PAGE')).toBeInTheDocument();
  });
  it('filters by tab and kind through the server\'s own parameters', async () => {
    route({ ...asRole(['FACULTY_REVIEWER']), 'GET /v1/moderation/queue?status=OPEN': () => res(200, []), 'GET /v1/moderation/queue?status=CLAIMED&mine=true': () => res(200, [row({ taskId: 'T9', status: 'CLAIMED', claimedById: 'me-1' })]), 'GET /v1/moderation/queue?status=CLAIMED&mine=true&kind=APPEAL': () => res(200, []) });
    const u = userEvent.setup(); queue(['FACULTY_REVIEWER']); expect(await screen.findByText('Nothing is waiting. Well done.')).toBeInTheDocument(); await u.click(screen.getByRole('button', { name: 'Claimed by me' })); expect(await screen.findByRole('button', { name: 'Open' })).toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('Show'), 'APPEAL'); expect(await screen.findByText('Nothing here.')).toBeInTheDocument();
  });
  it('oversight roles see the queue but cannot claim; a role without access is redirected before anything loads', async () => {
    route({ ...asRole(['AUDITOR']), 'GET /v1/moderation/queue?status=OPEN': () => res(200, [row()]), 'GET /v1/moderation/queue?status=CLAIMED': () => res(200, [row({ status: 'CLAIMED', claimedById: 'someone' })]) });
    const u = userEvent.setup(); queue(['AUDITOR']); expect(await screen.findByText('Submission 3f9a1c')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Claim and open' })).toBeNull(); await u.click(screen.getByRole('button', { name: 'Being reviewed' })); expect(await screen.findByText(/Being reviewed by someone else/)).toBeInTheDocument();
    calls = []; route({ ...asRole(['LAB_COORDINATOR']) }); queue(['LAB_COORDINATOR']); expect(await screen.findByText('STAFF HOME')).toBeInTheDocument(); expect(calls.some((c) => c.url.includes('/moderation/'))).toBe(false);
  });
});

describe('case file and decision', () => {
  const open = (f: CaseFile, extra: Record<string, H> = {}, roles = ['FACULTY_REVIEWER']) => { route({ ...asRole(roles), 'GET /v1/moderation/tasks/T1': () => res(200, f), ...extra }); return render(<MemoryRouter initialEntries={['/staff/moderation/T1']}><AuthProvider><Ready><Routes><Route path="/staff/moderation/:taskId" element={<ModerationCase />} /><Route path="/staff/moderation" element={<p>QUEUE</p>} /></Routes></Ready></AuthProvider></MemoryRouter>); };
  it('shows the submission, why it is here, and the full history including evidence that was NOT verified', async () => {
    open(file({ similarity: [{ score: 0.92, otherRef: 'zz99', excerpt: 'The platform gates progress...' }] })); expect(await screen.findByText('Submission 3f9a1c')).toBeInTheDocument(); expect(screen.getByLabelText('Submitted text')).toHaveTextContent('gates progress on the server'); expect(screen.getByText('notes.pdf (2 KB)')).toBeInTheDocument();
    expect(screen.getByText(/confidence 55%/)).toBeInTheDocument(); expect(screen.getByText(/NOT verified against the submission/)).toBeInTheDocument(); expect(screen.getByText('92% overlap')).toBeInTheDocument(); expect(screen.getByText('Staff only')).toBeInTheDocument();
  });
  it('previews the score as the reviewer types, rejects out-of-range scores, and sends scores with rationales', async () => {
    open(file(), { 'POST /v1/moderation/tasks/T1/decide': () => res(201, { state: 'GRADED', finalPercent: 82.5, passed: true, seq: 2 }) });
    const u = userEvent.setup(); const f = await screen.findByRole('form', { name: 'Decision' }); const c = within(f).getByLabelText(/Correctness/); await u.type(c, '5'); expect(within(f).getByRole('alert')).toHaveTextContent('Between 0 and 4'); await u.clear(c); await u.type(c, '3.5'); await u.type(within(f).getByLabelText(/Clarity/), '3');
    expect(within(f).getByText(/Estimated score: 82.5%/)).toBeInTheDocument(); await u.type(within(f).getAllByLabelText(/Why this score/)[0], 'Strong grasp'); await u.type(within(f).getByLabelText('Feedback for the learner'), 'Nice work.'); await u.type(within(f).getByLabelText(/Reason for your decision/), 'Reviewed fully'); await u.click(within(f).getByRole('button', { name: 'Submit decision' }));
    expect(await screen.findByText('Decision recorded')).toBeInTheDocument(); expect(screen.getByText('82.5%')).toBeInTheDocument(); expect(calls.find((c) => c.url.endsWith('/decide'))!.body).toEqual({ reason: 'Reviewed fully', feedback: 'Nice work.', dimensions: [{ id: 'correctness', score: 3.5, rationale: 'Strong grasp' }, { id: 'clarity', score: 3 }] });
  });
  it('lists every problem at once instead of sending an incomplete decision', async () => {
    open(file({ reasons: ['integrity:high_similarity'] })); const u = userEvent.setup(); const f = await screen.findByRole('form', { name: 'Decision' }); await u.click(within(f).getByRole('button', { name: 'Submit decision' }));
    const a = within(f).getByRole('alert'); for (const t of [/reason/i, /Correctness/, /Clarity/, /integrity flag/]) expect(a).toHaveTextContent(t); expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
  it('clears the "please fix" list as soon as the reviewer edits, instead of leaving stale warnings', async () => {
    open(file()); const u = userEvent.setup(); const f = await screen.findByRole('form', { name: 'Decision' }); await u.click(within(f).getByRole('button', { name: 'Submit decision' })); expect(within(f).getByRole('alert')).toHaveTextContent('Please fix');
    await u.type(within(f).getByLabelText(/Reason for your decision/), 'x'); expect(within(f).queryByText('Please fix:')).toBeNull();
  });
  it('can start from the AI\'s scores, and confirming the AI grade sends no dimensions', async () => {
    open(file(), { 'POST /v1/moderation/tasks/T1/decide': () => res(201, { state: 'GRADED', finalPercent: 65, passed: true, seq: 2 }) }); const u = userEvent.setup(); const f = await screen.findByRole('form', { name: 'Decision' });
    await u.click(within(f).getByRole('button', { name: /Start from the AI's scores/ })); expect(within(f).getByLabelText(/Correctness/)).toHaveValue(3); expect(within(f).getByLabelText(/Clarity/)).toHaveValue(2);
    await u.click(within(f).getByLabelText(/agree with it as it stands/)); expect(within(f).queryByLabelText(/Correctness/)).toBeNull(); await u.type(within(f).getByLabelText(/Reason for your decision/), 'AI grade is right'); await u.click(within(f).getByRole('button', { name: 'Submit decision' }));
    await screen.findByText('Decision recorded'); expect(calls.find((c) => c.url.endsWith('/decide'))!.body).toEqual({ reason: 'AI grade is right', feedback: 'Decent.', confirmAi: true }); // the feedback carried over from the AI's draft is kept
  });
  it('an integrity flag forces an explicit decision and sends it', async () => {
    open(file({ reasons: ['integrity:high_similarity'] }), { 'POST /v1/moderation/tasks/T1/decide': () => res(201, { state: 'GRADED', finalPercent: 50, passed: false, seq: 2 }) }); const u = userEvent.setup(); const f = await screen.findByRole('form', { name: 'Decision' });
    await u.type(within(f).getByLabelText(/Correctness/), '2'); await u.type(within(f).getByLabelText(/Clarity/), '2'); await u.type(within(f).getByLabelText(/Reason for your decision/), 'Checked the overlap'); await u.click(within(f).getByLabelText(/Concern confirmed/)); await u.click(within(f).getByRole('button', { name: 'Submit decision' }));
    await screen.findByText('Decision recorded'); expect(calls.find((c) => c.url.endsWith('/decide'))!.body).toMatchObject({ integrityOutcome: 'CONFIRMED_CONCERN' });
  });
  it('an appeal needs an outcome, explains why you were chosen, and "upheld" cannot change the scores', async () => {
    const appeal = file({ task: { id: 'T1', kind: 'APPEAL', status: 'CLAIMED', reasons: ['appeal: missed my example'], claimedById: 'me-1' }, reasons: ['appeal: missed my example'], records: [rec({ kind: 'MODERATED', rawPercent: 65 })] });
    open(appeal, { 'POST /v1/moderation/tasks/T1/decide': () => res(201, { state: 'FINAL', finalPercent: 90, passed: true, seq: 3 }) }); const u = userEvent.setup(); const f = await screen.findByRole('form', { name: 'Decision' }); expect(screen.getByText(/did not give the original grade/)).toBeInTheDocument(); expect(within(f).queryByLabelText(/agree with it as it stands/)).toBeNull();
    await u.type(within(f).getByLabelText(/Correctness/), '4'); await u.type(within(f).getByLabelText(/Clarity/), '3.5'); await u.type(within(f).getByLabelText(/Reason for your decision/), 'Example was present'); await u.click(within(f).getByLabelText(/Upheld/)); await u.click(within(f).getByRole('button', { name: 'Submit decision' })); expect(within(f).getByRole('alert')).toHaveTextContent(/"Upheld" means the grade is unchanged/);
    await u.click(within(f).getByLabelText(/Adjusted/)); await u.click(within(f).getByRole('button', { name: 'Submit decision' })); await screen.findByText('Decision recorded'); expect(calls.find((c) => c.url.endsWith('/decide'))!.body.outcome).toBe('ADJUSTED');
  });
  it('shows the server\'s refusal and keeps the work; gives a task back to the queue', async () => {
    open(file(), { 'POST /v1/moderation/tasks/T1/decide': () => res(409, { message: 'claim the task first' }), 'POST /v1/moderation/tasks/T1/release': () => res(201, { ok: true }) }); const u = userEvent.setup(); const f = await screen.findByRole('form', { name: 'Decision' });
    await u.type(within(f).getByLabelText(/Correctness/), '2'); await u.type(within(f).getByLabelText(/Clarity/), '2'); await u.type(within(f).getByLabelText(/Reason for your decision/), 'x'); await u.click(within(f).getByRole('button', { name: 'Submit decision' })); expect(await within(f).findByText('claim the task first')).toBeInTheDocument(); expect(within(f).getByLabelText(/Correctness/)).toHaveValue(2);
    await u.click(within(f).getByRole('button', { name: 'Give back to the queue' })); expect(await screen.findByText('Returned to the queue')).toBeInTheDocument();
  });
  it('only reviewers open case files: oversight roles go back to the queue without fetching', async () => {
    open(file(), {}, ['ACADEMIC_ADMIN']); expect(await screen.findByText('QUEUE')).toBeInTheDocument(); expect(calls.some((c) => c.url.includes('/tasks/T1'))).toBe(false);
  });
  it('explains a conflict of interest or an unclaimed task instead of failing silently', async () => {
    route({ ...asRole(['FACULTY_REVIEWER']), 'GET /v1/moderation/tasks/T1': () => res(403, { message: 'conflict of interest' }) }); render(<MemoryRouter initialEntries={['/staff/moderation/T1']}><AuthProvider><Ready><Routes><Route path="/staff/moderation/:taskId" element={<ModerationCase />} /></Routes></Ready></AuthProvider></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('conflict of interest'); expect(screen.getByRole('link', { name: 'Back to the queue' })).toBeInTheDocument();
  });
});
