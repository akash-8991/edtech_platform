import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AiGenerate from '../staff/AiGenerate';
import AiJobPage from '../staff/AiJob';
import Content from '../staff/Content';
import ContentVersion from '../staff/ContentVersion';
import { AuthProvider, useAuth } from '../auth';
import { api } from '../api/client';
import { curriculumBody, curriculumProblem, emptyCurriculum, failureHelp, isFinished, jobLabel, topicBody, topicProblem, videoSteps } from '../lib/aigen';
import type { VersionTree } from '../api/types';

configure({ asyncUtilTimeout: 5000 });
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let calls: { method: string; url: string; body: any }[] = [];
type H = (c: { body: any; n: number }) => Response;
const route = (map: Record<string, H>) => { const counts: Record<string, number> = {}; vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => { const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined; calls.push({ method, url, body });
  const k = `${method} ${url}`; counts[k] = (counts[k] ?? 0) + 1; const h = map[k]; return h ? h({ body, n: counts[k] }) : res(404, { message: `no route ${k}` }); })); };
beforeEach(() => { calls = []; api.clear(); });
const signIn = (roles: string[], id = 'me') => { api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); return { 'GET /v1/auth/me': () => res(200, { id, email: 's@x.test', name: 'Sam', language: 'en', roles, mfaEnabled: true }) } as Record<string, H>; };
const Gate = ({ children }: { children: JSX.Element }) => (useAuth().loading ? <p>loading</p> : children);
const mount = (path: string, pollMs = 20) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><Gate><Routes><Route path="/staff" element={<p>staff home</p>} /><Route path="/staff/content" element={<Content />} /><Route path="/staff/content/generate" element={<AiGenerate />} /><Route path="/staff/content/jobs/:jobId" element={<AiJobPage pollMs={pollMs} />} /><Route path="/staff/content/versions/:versionId" element={<ContentVersion />} /></Routes></Gate></AuthProvider></MemoryRouter>);
const job = (o: any = {}) => ({ id: 'j1', kind: 'CURRICULUM', status: 'QUEUED', error: null, result: null, attempts: 0, costUsd: 0, versionId: null, topicId: null, requestedById: 'me', createdAt: '2030-01-01T10:00:00Z', startedAt: null, finishedAt: null, inputSummary: { kind: 'CURRICULUM', references: 0 }, ...o });

describe('generator helpers', () => {
  const ok = { ...emptyCurriculum(), code: 'IOT-101', title: 'IoT', discipline: 'Electronics', audience: 'Diploma students', hours: '40', outcomes: 'Explain a sensor\n\n Wire a circuit ' };
  it('checks the form in plain words and builds the request', () => {
    expect(curriculumProblem(ok)).toBeNull(); expect(curriculumProblem({ ...ok, code: '' })).toMatch(/short code/); expect(curriculumProblem({ ...ok, code: 'a b' })).toMatch(/letters, numbers/); expect(curriculumProblem({ ...ok, title: ' ' })).toMatch(/title/); expect(curriculumProblem({ ...ok, discipline: '' })).toMatch(/discipline/); expect(curriculumProblem({ ...ok, audience: '' })).toMatch(/who it is for/);
    for (const h of ['0', '2.5', '5001', 'x']) expect(curriculumProblem({ ...ok, hours: h })).toMatch(/whole number/); expect(curriculumProblem({ ...ok, outcomes: ' \n ' })).toMatch(/learning outcome/); expect(curriculumProblem({ ...ok, languages: ['hi'] })).toMatch(/English/); expect(curriculumProblem({ ...ok, refText: 'x'.repeat(400_001) })).toMatch(/too long/);
    expect(curriculumBody(ok)).toEqual({ programme: { code: 'IOT-101', title: 'IoT' }, title: 'IoT', discipline: 'Electronics', audience: 'Diploma students', durationType: 'M12', hours: 40, outcomes: ['Explain a sensor', 'Wire a circuit'], prerequisites: [], languages: ['en'] });
    expect(curriculumBody({ ...ok, languages: ['en', 'hi'], refTitle: 'Syllabus', refText: ' text ' }).references).toEqual([{ id: 'ref-1', title: 'Syllabus', text: 'text' }]);
    expect(topicProblem('', ['en'], '')).toMatch(/topic/); expect(topicProblem('t1', [], '')).toMatch(/language/); expect(topicProblem('t1', ['en'], '')).toBeNull(); expect(topicBody('t1', ' cover x ', ['en'], '')).toEqual({ topicId: 't1', instruction: 'cover x', languages: ['en'] }); expect(topicBody('t1', '', ['en'], 'ref').references).toHaveLength(1);
  });
  it('explains each way a job can fail, and names the states', () => {
    const f = (result: any) => failureHelp({ status: 'FAILED', error: 'x', result });
    expect(f({ error: 'ai_disabled' })).toMatch(/switched off/); expect(f({ error: 'ai_limit', message: 'daily AI budget exhausted' })).toMatch(/budget exhausted/); expect(f({ error: 'ai_unavailable', attempts: [{ error: 'not_configured' }] })).toMatch(/No AI provider is set up/); expect(f({ error: 'ai_unavailable', attempts: [{ error: 'timeout: x' }] })).toMatch(/could not be reached/);
    expect(f({ code: 'validation_failed' })).toMatch(/did not pass the checks/); expect(f({ code: 'not_draft' })).toMatch(/no longer a draft/); expect(f({})).toMatch(/Something went wrong/); expect(failureHelp({ status: 'SUCCEEDED', error: null, result: null })).toBeNull();
    expect(jobLabel('RUNNING')).toBe('Being written'); expect(jobLabel('ODD')).toBe('odd'); expect(isFinished('QUEUED')).toBe(false); expect(isFinished('FAILED')).toBe(true); expect(videoSteps('https://x', 'tp')).toMatch(/--topic-id tp --abr/);
  });
});

describe('the Write a course with AI screen', () => {
  const base = (extra: Record<string, H> = {}) => ({ 'GET /v1/ai/jobs': () => res(200, [job({ status: 'SUCCEEDED', costUsd: 0.12 })]), ...extra });
  it('only authors and academic admins get it; others are sent back before anything is fetched', async () => {
    route({ ...signIn(['FACULTY_REVIEWER']), 'GET /v1/authoring/programmes': () => res(200, []) }); mount('/staff/content/generate'); await screen.findByRole('heading', { name: 'Content' }); expect(screen.queryByRole('heading', { name: 'Write a course with AI' })).toBeNull(); expect(calls.some((c) => c.url.includes('/v1/ai/'))).toBe(false);
  });
  it('is offered on the Content screen to the roles who can use it', async () => {
    route({ ...signIn(['CONTENT_AUTHOR']), 'GET /v1/authoring/programmes': () => res(200, []) }); const a = mount('/staff/content'); expect(await screen.findByRole('link', { name: 'Write a course with AI' })).toHaveAttribute('href', '/staff/content/generate'); a.unmount();
    route({ ...signIn(['FACULTY_REVIEWER']), 'GET /v1/authoring/programmes': () => res(200, []) }); mount('/staff/content'); await screen.findByText(/No programmes yet/); expect(screen.queryByRole('link', { name: 'Write a course with AI' })).toBeNull();
  });
  it('refuses an incomplete form without calling the server, then sends the job and opens its page', async () => {
    let sent: any = null; route({ ...signIn(['CONTENT_AUTHOR']), ...base({ 'POST /v1/ai/curriculum-jobs': ({ body }) => { sent = body; return res(202, { jobId: 'j1', status: 'QUEUED' }); }, 'GET /v1/ai/jobs/j1': () => res(200, job()) }) }); mount('/staff/content/generate');
    await screen.findByText('Recent AI jobs'); await userEvent.click(screen.getByRole('button', { name: 'Write the course' })); expect(await screen.findByRole('alert')).toHaveTextContent(/short code/); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.type(screen.getByLabelText('Programme code'), 'IOT-101'); await userEvent.type(screen.getByLabelText('Title'), 'Intro to IoT'); await userEvent.type(screen.getByLabelText('Discipline'), 'Electronics'); await userEvent.type(screen.getByLabelText('Who is it for?'), 'Diploma students');
    await userEvent.type(screen.getByLabelText('Learning outcomes (one per line)'), 'Explain a sensor'); await userEvent.click(screen.getByLabelText('Hindi as well')); await userEvent.click(screen.getByRole('button', { name: 'Write the course' }));
    expect(await screen.findByRole('heading', { name: /Whole course · AI job/ })).toBeInTheDocument(); expect(sent).toMatchObject({ programme: { code: 'IOT-101', title: 'Intro to IoT' }, durationType: 'M12', hours: 40, outcomes: ['Explain a sensor'], languages: ['en', 'hi'] });
  });
  it('shows the server\'s refusal and lists recent jobs with links', async () => {
    route({ ...signIn(['ACADEMIC_ADMIN']), ...base({ 'POST /v1/ai/curriculum-jobs': () => res(400, { message: 'durationType M12|M18 and integer hours 1..5000' }) }) }); mount('/staff/content/generate');
    expect(await screen.findByRole('link', { name: /2030/ })).toHaveAttribute('href', '/staff/content/jobs/j1'); expect(screen.getByText('$0.120')).toBeInTheDocument();
    for (const [l, v] of [['Programme code', 'A1'], ['Title', 'T'], ['Discipline', 'D'], ['Who is it for?', 'S'], ['Learning outcomes (one per line)', 'o']]) await userEvent.type(screen.getByLabelText(l), v);
    await userEvent.click(screen.getByRole('button', { name: 'Write the course' })); expect(await screen.findByRole('alert')).toHaveTextContent(/durationType/);
  });
});

describe('the AI job page', () => {
  it('follows a job from waiting to done, then points at the draft, shows what the AI assumed, and gives the video steps', async () => {
    const steps = [job(), job({ status: 'RUNNING', attempts: 1 }), job({ status: 'SUCCEEDED', attempts: 1, costUsd: 0.31, finishedAt: '2030-01-01T10:05:00Z', versionId: 'v9', topicId: 'tp9', result: { versionId: 'v9', modules: 3, topics: 8, findings: 2, assumptions: ['Assumed learners know basic algebra'] } })];
    route({ ...signIn(['CONTENT_AUTHOR']), 'GET /v1/ai/jobs/j1': ({ n }) => res(200, steps[Math.min(n - 1, 2)]) }); mount('/staff/content/jobs/j1');
    await screen.findByText(/waiting for a free worker/); await screen.findByText(/The AI is writing/); await screen.findByRole('heading', { name: 'Your draft is ready' }); expect(screen.getByRole('link', { name: 'Open the draft' })).toHaveAttribute('href', '/staff/content/versions/v9');
    expect(screen.getByText('3 modules and 8 topics were written.')).toBeInTheDocument(); expect(screen.getByText(/2 quality checks need attention/)).toBeInTheDocument(); expect(screen.getByText('Assumed learners know basic algebra')).toBeInTheDocument(); expect(screen.getByText(/--topic-id tp9 --abr/)).toBeInTheDocument();
    const n = calls.filter((c) => c.url.endsWith('/j1')).length; await new Promise((r) => setTimeout(r, 120)); expect(calls.filter((c) => c.url.endsWith('/j1')).length).toBe(n); // stops polling once finished
  });
  it('says why a failure happened and what to do, for each reason', async () => {
    for (const [result, text] of [[{ error: 'ai_unavailable', attempts: [{ error: 'not_configured' }] }, /No AI provider is set up/], [{ error: 'ai_disabled' }, /switched off/], [{ code: 'validation_failed', detail: [{ gate: 'outcomes', message: 'Outcome 2 is not covered' }] }, /did not pass the checks/]] as const) {
      route({ ...signIn(['ACADEMIC_ADMIN']), 'GET /v1/ai/jobs/j1': () => res(200, job({ status: 'FAILED', error: 'tech detail', result })) }); const { unmount } = mount('/staff/content/jobs/j1'); expect(await screen.findByRole('alert')).toHaveTextContent(text); expect(screen.getByText('tech detail')).toBeInTheDocument(); unmount(); api.clear();
    }
  });
  it('lets the owner cancel a queued job, and shows a cancelled job as such', async () => {
    let cancelled = false; route({ ...signIn(['CONTENT_AUTHOR']), 'GET /v1/ai/jobs/j1': () => res(200, job({ status: cancelled ? 'CANCELLED' : 'QUEUED' })), 'POST /v1/ai/jobs/j1/cancel': () => { cancelled = true; return res(201, { ok: true }); } }); mount('/staff/content/jobs/j1');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel the job' })); expect(await screen.findByText(/The job was cancelled/)).toBeInTheDocument();
  });
  it('shows a job that cannot be found, and keeps the video commands out of whole-course jobs', async () => {
    route({ ...signIn(['CONTENT_AUTHOR']), 'GET /v1/ai/jobs/j1': () => res(404, { message: 'Not Found' }) }); const a = mount('/staff/content/jobs/j1'); expect(await screen.findByRole('alert')).toBeInTheDocument(); a.unmount();
    route({ ...signIn(['CONTENT_AUTHOR']), 'GET /v1/ai/jobs/j1': () => res(200, job({ status: 'SUCCEEDED', versionId: 'v1', result: { versionId: 'v1', modules: 1, topics: 1, findings: 0, assumptions: [] } })) }); mount('/staff/content/jobs/j1'); await screen.findByRole('heading', { name: 'Your draft is ready' }); expect(screen.queryByText(/Turn this topic's script into video/)).toBeNull();
  });
});

describe('writing one topic of a draft with AI', () => {
  const tree = (over: Partial<VersionTree> = {}): VersionTree => ({ id: 'v1', version: 1, state: 'DRAFT', hours: 2, outcomes: ['x'], languages: ['en', 'hi'], provenance: {}, authorId: 'me', createdAt: '2030-01-01T00:00:00Z', publishedAt: null, programme: { id: 'p', code: 'AIML', title: 'AI/ML', discipline: 'AI' },
    modules: [{ id: 'm1', position: 1, title: 'Basics', topics: [{ id: 't1', position: 1, title: 'Intro', hours: 2, outcomes: [], prerequisites: [], mandatory: true, quiz: null, assignment: null, assets: [] }] }], approvals: [], comments: [], people: { me: 'Sam' }, ...over });
  const base = (t: VersionTree, extra: Record<string, H> = {}) => ({ [`GET /v1/authoring/versions/${t.id}/tree`]: () => res(200, t), [`GET /v1/ai/quality?versionId=${t.id}`]: () => res(200, { open: 0, findings: [] }), [`GET /v1/authoring/versions/${t.id}/accessibility`]: () => res(200, { blocking: 0, advisory: 0, enforced: false, issues: [] }), 'GET /v1/authoring/programmes': () => res(200, []),
    'GET /v1/ai/jobs': () => res(200, [job({ versionId: 'v1', kind: 'TOPIC_CONTENT', status: 'FAILED' }), job({ id: 'other', versionId: 'v2' })]), ...extra });
  it('the author picks a topic, adds guidance, and the job starts; recent jobs for this draft are listed', async () => {
    let sent: any = null; const t = tree(); route({ ...signIn(['CONTENT_AUTHOR']), ...base(t, { 'POST /v1/ai/topic-jobs': ({ body }) => { sent = body; return res(202, { jobId: 'j7', status: 'QUEUED' }); }, 'GET /v1/ai/jobs/j7': () => res(200, job({ id: 'j7', kind: 'TOPIC_CONTENT' })) }) }); mount('/staff/content/versions/v1');
    await screen.findByRole('heading', { name: 'Write a topic with AI' }); expect(await screen.findAllByRole('link', { name: /2030/ })).toHaveLength(1); // only this version's job, not the other draft's
    await userEvent.click(screen.getByRole('button', { name: 'Write this topic' })); expect(await screen.findByText('Choose the topic.')).toBeInTheDocument(); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.selectOptions(screen.getByLabelText('Topic'), 't1'); await userEvent.type(screen.getByLabelText('What should it cover? (optional)'), 'Use a worked example'); const panel = within(screen.getByRole('heading', { name: 'Write a topic with AI' }).closest('section')!); await userEvent.click(panel.getByLabelText('Hindi')); await userEvent.click(panel.getByRole('button', { name: 'Write this topic' }));
    await screen.findByRole('heading', { name: /One topic · AI job/ }); expect(sent).toEqual({ topicId: 't1', instruction: 'Use a worked example', languages: ['en'] });
  });
  it('is not offered when the draft is frozen, belongs to someone else, or the person is a reviewer', async () => {
    const t = tree({ state: 'FACULTY_REVIEW' }); route({ ...signIn(['CONTENT_AUTHOR']), ...base(t) }); const a = mount('/staff/content/versions/v1'); await screen.findByRole('heading', { name: 'Where this stands' }); expect(screen.queryByRole('heading', { name: 'Write a topic with AI' })).toBeNull(); a.unmount();
    const u = tree({ authorId: 'someone-else' }); route({ ...signIn(['CONTENT_AUTHOR']), ...base(u) }); const b = mount('/staff/content/versions/v1'); await screen.findByRole('heading', { name: 'Where this stands' }); expect(screen.queryByRole('heading', { name: 'Write a topic with AI' })).toBeNull(); b.unmount();
    route({ ...signIn(['FACULTY_REVIEWER']), ...base(tree()) }); mount('/staff/content/versions/v1'); await screen.findByRole('heading', { name: 'Where this stands' }); expect(screen.queryByRole('heading', { name: 'Write a topic with AI' })).toBeNull();
  });
});
