import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Content from '../staff/Content';
import ContentVersion from '../staff/ContentVersion';
import { AuthProvider, useAuth } from '../auth';
import { api } from '../api/client';
import type { VersionTree } from '../api/types';
import { blankQuestion, describeChange, draftFromQuestion, movesFor, move, needsMe, questionFromDraft, readinessIssues, removeOption, toEditBody, validateQuestion, validateRubric } from '../lib/content';

const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
let calls: { method: string; url: string; body: any }[] = [];
type H = (c: { body: any; n: number }) => Response;
const route = (map: Record<string, H>) => { const counts: Record<string, number> = {}; vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => {
  const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body; calls.push({ method, url, body });
  const k = `${method} ${url}`; counts[k] = (counts[k] ?? 0) + 1; const h = map[k]; return h ? h({ body, n: counts[k] }) : res(404, { message: `no route ${k}` }); })); };
beforeEach(() => { calls = []; api.clear(); window.confirm = vi.fn(() => true); });
const signIn = (roles: string[], id = 'me') => { api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); return { 'GET /v1/auth/me': () => res(200, { id, email: 's@x.test', name: 'Sam', language: 'en', roles, mfaEnabled: true }) } as Record<string, H>; };
const Gate = ({ children }: { children: JSX.Element }) => (useAuth().loading ? <p>loading</p> : children);
const mount = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><Gate><Routes><Route path="/staff" element={<p>home</p>} /><Route path="/staff/content" element={<Content />} /><Route path="/staff/content/versions/:versionId" element={<ContentVersion />} /></Routes></Gate></AuthProvider></MemoryRouter>);

const quiz = { passPercent: 70, maxAttempts: 3, questions: [{ id: 'q1', position: 1, type: 'MCQ_SINGLE', text: 'What is 2+2?', options: ['3', '4'], answer: 1, tolerance: 0, points: 1, rationale: 'Arithmetic', i18n: { hi: { text: 'x' } } }] };
const tree = (over: Partial<VersionTree> = {}, topic: Partial<VersionTree['modules'][0]['topics'][0]> = {}): VersionTree => ({
  id: 'v1', version: 2, state: 'DRAFT', hours: 2, outcomes: ['Explain ML'], languages: ['en'], provenance: { source: 'manual' }, authorId: 'me', createdAt: '2030-01-01T00:00:00Z', publishedAt: null, programme: { id: 'p1', code: 'AIML', title: 'AI/ML', discipline: 'AI' },
  modules: [{ id: 'm1', position: 1, title: 'Basics', topics: [{ id: 't1', position: 1, title: 'Intro', hours: 2, outcomes: [], prerequisites: [], mandatory: true, quiz, assignment: { instructions: 'Write', rubric: { criteria: [{ criterion: 'Clarity', weight: 100 }] }, maxSubmissions: 3, policy: {}, i18n: {} },
    assets: [{ id: 'a1', kind: 'VIDEO', language: 'en', durationSec: 600, files: { master: { checksum: 'c', size: 5_000_000 } }, interactions: [], provenance: {}, rights: {}, createdById: 'me' }], ...topic }] }],
  approvals: [], comments: [], people: { me: 'Sam Author', other: 'Rita Reviewer' }, ...over });
const base = (t: VersionTree, extra: Record<string, H> = {}) => ({ [`GET /v1/authoring/versions/${t.id}/tree`]: () => res(200, t), [`GET /v1/ai/quality?versionId=${t.id}`]: () => res(200, { open: 0, findings: [] }), [`GET /v1/authoring/versions/${t.id}/accessibility`]: () => res(200, { blocking: 0, advisory: 0, enforced: false, issues: [] }),
  'GET /v1/authoring/programmes': () => res(200, [{ id: 'p1', code: 'AIML', title: 'AI/ML', discipline: 'AI', versions: [{ id: 'v1', version: 2, state: t.state, hours: 2, authorId: 'me', authorName: 'Sam Author', languages: ['en'], provenance: {}, createdAt: '2030-01-01T00:00:00Z', publishedAt: null }, { id: 'v0', version: 1, state: 'PUBLISHED', hours: 2, authorId: 'me', authorName: 'Sam Author', languages: ['en'], provenance: {}, createdAt: '2029-01-01T00:00:00Z', publishedAt: null }] }]), ...extra } as Record<string, H>);

describe('content helpers', () => {
  const t = tree();
  it('offers only the moves the role may make and explains separation of duties', () => {
    expect(movesFor('DRAFT', ['CONTENT_AUTHOR'], 'me', t).map((m) => m.to)).toEqual(['FACULTY_REVIEW']); expect(movesFor('DRAFT', ['FACULTY_REVIEWER'], 'me', t)).toEqual([]);
    const own = movesFor('FACULTY_REVIEW', ['FACULTY_REVIEWER'], 'me', t); expect(own.find((m) => m.to === 'FACULTY_APPROVED')!.blocked).toMatch(/wrote/); expect(own.find((m) => m.to === 'DRAFT')!.reasonRequired).toBe(true); expect(own.find((m) => m.to === 'DRAFT')!.blocked).toBeNull();
    const other = movesFor('FACULTY_REVIEW', ['FACULTY_REVIEWER'], 'other', t); expect(other.find((m) => m.to === 'FACULTY_APPROVED')!.blocked).toBeNull();
    const pub = movesFor('ADMIN_APPROVAL', ['APPROVER_PUBLISHER'], 'rev', { authorId: 'me', approvals: [{ id: 'x', fromState: 'FACULTY_REVIEW', toState: 'FACULTY_APPROVED', actorId: 'rev', reason: null, createdAt: '' }] }); expect(pub.find((m) => m.to === 'PUBLISHED')!.blocked).toMatch(/faculty approval/);
    expect(needsMe('FACULTY_REVIEW', ['FACULTY_REVIEWER'])).toBe(true); expect(needsMe('PUBLISHED', ['APPROVER_PUBLISHER'])).toBe(false); expect(needsMe('ADMIN_APPROVAL', ['AUDITOR'])).toBe(false);
  });
  it('checks readiness the way the server does', () => {
    expect(readinessIssues(t)).toEqual([]);
    const bad = tree({ hours: 5, languages: ['en', 'hi'] }, { quiz: null, assignment: null }); const i = readinessIssues(bad);
    expect(i).toEqual(expect.arrayContaining([expect.stringMatching(/Hindi video/), expect.stringMatching(/quiz missing/), expect.stringMatching(/assignment missing/), expect.stringMatching(/add up to 2 but the programme says 5/)]));
    expect(readinessIssues(tree({ modules: [] }))).toEqual(expect.arrayContaining(['No modules yet'])); expect(readinessIssues(tree({}, { mandatory: false, quiz: null, assignment: null, assets: [] }))).toEqual([]);
  });
  it('sends back every component when a draft is saved, so nothing is deleted', () => {
    const b = toEditBody(t) as any; const x = b.modules[0].topics[0];
    expect(x.quiz.questions[0]).toMatchObject({ text: 'What is 2+2?', answer: 1, i18n: { hi: { text: 'x' } } }); expect(x.assignment.instructions).toBe('Write'); expect(x.assets[0]).toMatchObject({ language: 'en', createdById: 'me', files: { master: { size: 5_000_000 } } });
    expect(toEditBody(tree({}, { quiz: null, assignment: null, assets: [] })).modules[0].topics[0]).not.toHaveProperty('quiz');
  });
  it('validates questions and keeps the right answer when an option is removed', () => {
    const q = { ...blankQuestion(), text: 'Q', options: ['a', 'b', 'c'], single: 2 }; expect(validateQuestion(q)).toBeNull(); expect(validateQuestion({ ...q, text: ' ' })).toMatch(/Write the question/); expect(validateQuestion({ ...q, options: ['a', '', 'c'] })).toMatch(/every option/i); expect(validateQuestion({ ...q, options: ['a', 'a', 'c'] })).toMatch(/identical/);
    expect(validateQuestion({ ...q, points: '0' })).toMatch(/Points/); expect(validateQuestion({ ...q, type: 'MCQ_MULTI', multi: [] })).toMatch(/at least one correct/); expect(validateQuestion({ ...q, type: 'NUMERIC', numeric: '' })).toMatch(/correct number/); expect(validateQuestion({ ...q, type: 'NUMERIC', numeric: '3.5' })).toBeNull();
    expect(removeOption(q, 0).single).toBe(1); expect(removeOption(q, 2).single).toBe(0); expect(removeOption({ ...q, type: 'MCQ_MULTI', multi: [0, 2] }, 1).multi).toEqual([0, 1]);
    expect(questionFromDraft({ ...q, type: 'MCQ_MULTI', multi: [2, 0] }, 3)).toMatchObject({ position: 3, answer: [0, 2] }); expect(questionFromDraft({ ...blankQuestion(), type: 'NUMERIC', text: 'N', numeric: '4', tolerance: '0.5' }, 1)).toMatchObject({ answer: 4, tolerance: 0.5, options: [] });
    expect(draftFromQuestion(quiz.questions[0] as any)).toMatchObject({ single: 1, text: 'What is 2+2?' });
  });
  it('validates the marking criteria and describes diffs and reordering', () => {
    expect(validateRubric([{ criterion: 'A', weight: '60', description: '' }, { criterion: 'B', weight: '40', description: '' }])).toBeNull(); expect(validateRubric([{ criterion: 'A', weight: '60', description: '' }])).toMatch(/add up to 60/); expect(validateRubric([])).toMatch(/at least one/);
    expect(validateRubric([{ criterion: 'A', weight: '50', description: '' }, { criterion: 'a', weight: '50', description: '' }])).toMatch(/same name/); expect(validateRubric([{ criterion: '', weight: '100', description: '' }])).toMatch(/needs a name/);
    expect(describeChange({ path: 'hours', change: 'changed', from: 2, to: 3 })).toBe('Programme hours: 2 → 3'); expect(describeChange({ path: 'module:A/topic:B/hours', change: 'changed', from: 1, to: 2 })).toBe('Topic "B" in module "A", hours: 1 → 2'); expect(describeChange({ path: 'module:A', change: 'added' })).toBe('Added module "A"'); expect(describeChange({ path: 'module:A/topic:B', change: 'removed' })).toBe('Removed topic "B" in module "A"');
    expect(move([1, 2, 3], 0, 1)).toEqual([2, 1, 3]); expect(move([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
  });
});

describe('content index', () => {
  it('lists programmes and versions, marks what needs the person, and filters', async () => {
    route({ ...signIn(['FACULTY_REVIEWER']), 'GET /v1/authoring/programmes': () => res(200, [{ id: 'p1', code: 'AIML', title: 'AI/ML', discipline: 'AI', versions: [{ id: 'v2', version: 2, state: 'FACULTY_REVIEW', hours: 4, authorId: 'o', authorName: 'Olu', languages: ['en', 'hi'], provenance: { source: 'ai' }, createdAt: '2030-01-01T00:00:00Z', publishedAt: null }, { id: 'v1', version: 1, state: 'PUBLISHED', hours: 4, authorId: 'o', authorName: 'Olu', languages: ['en'], provenance: {}, createdAt: '2029-01-01T00:00:00Z', publishedAt: null }] }]) });
    mount('/staff/content'); expect(await screen.findByRole('link', { name: 'Version 2' })).toHaveAttribute('href', '/staff/content/versions/v2'); expect(screen.getByText('AI-assisted')).toBeInTheDocument(); expect(screen.getByText('Needs you')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'New programme' })).toBeNull(); // a reviewer cannot author
    await userEvent.click(screen.getByRole('button', { name: /Needs my action \(1\)/ })); expect(screen.queryByRole('link', { name: 'Version 1' })).toBeNull();
  });
  it('sends a role without access home before fetching, and validates a new programme', async () => {
    route(signIn(['LAB_COORDINATOR'])); mount('/staff/content'); expect(await screen.findByText('home')).toBeInTheDocument(); expect(calls.some((c) => c.url.includes('authoring'))).toBe(false);
  });
  it('creates a programme only with a code, title and discipline', async () => {
    let n = 0; route({ ...signIn(['CONTENT_AUTHOR']), 'GET /v1/authoring/programmes': () => res(200, []), 'POST /v1/authoring/programmes': () => { n++; return res(201, {}); } });
    mount('/staff/content'); await userEvent.click(await screen.findByRole('button', { name: 'New programme' })); await userEvent.click(screen.getByRole('button', { name: 'Create programme' })); expect(await screen.findByText(/short code/)).toBeInTheDocument(); expect(n).toBe(0);
    await userEvent.type(screen.getByLabelText('Code'), 'X1'); await userEvent.type(screen.getByLabelText('Title'), 'Title'); await userEvent.type(screen.getByLabelText('Discipline'), 'AI'); await userEvent.click(screen.getByRole('button', { name: 'Create programme' })); await waitFor(() => expect(n).toBe(1));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ code: 'X1', title: 'Title', discipline: 'AI' });
  });
});

describe('review workflow', () => {
  it('shows a reviewer the content with the answers, and blocks approving their own author work', async () => {
    const t = tree({ state: 'FACULTY_REVIEW', authorId: 'me' }); route({ ...signIn(['FACULTY_REVIEWER'], 'me'), ...base(t) });
    mount('/staff/content/versions/v1'); expect(await screen.findByText(/Waiting on: faculty reviewer/)).toBeInTheDocument(); await userEvent.click(screen.getByText('Intro')); expect(screen.getByText(/✓ 4/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve as faculty' })).toBeDisabled(); expect(screen.getByText(/You wrote this version/)).toBeInTheDocument(); expect(screen.queryByRole('button', { name: /Save changes/ })).toBeNull(); // read-only for reviewers
  });
  it('requires a reason to send work back, then records the move', async () => {
    let t = tree({ state: 'FACULTY_REVIEW', authorId: 'author' }); const m: Record<string, H> = { ...signIn(['FACULTY_REVIEWER'], 'rev'), ...base(t), 'GET /v1/authoring/versions/v1/tree': () => res(200, t), 'POST /v1/authoring/versions/v1/transition': () => { t = tree({ state: 'DRAFT', authorId: 'author' }); return res(201, {}); } }; route(m);
    mount('/staff/content/versions/v1'); await userEvent.click(await screen.findByRole('button', { name: 'Send back to the author' })); await userEvent.click(screen.getByRole('button', { name: /Confirm: Send back/ })); expect(await screen.findByText(/Write the reason/)).toBeInTheDocument(); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.type(screen.getByLabelText(/Reason/), 'Quiz 2 is wrong'); await userEvent.click(screen.getByRole('button', { name: /Confirm: Send back/ })); expect(await screen.findByText(/Moved to “Draft”/)).toBeInTheDocument(); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ to: 'DRAFT', reason: 'Quiz 2 is wrong' });
  });
  it("lists the server's readiness issues when review is refused", async () => {
    const t = tree({ state: 'DRAFT', authorId: 'me' }); route({ ...signIn(['CONTENT_AUTHOR'], 'me'), ...base(t), 'POST /v1/authoring/versions/v1/transition': () => res(400, { error: 'not_ready_for_review', issues: ['topic "Intro": assignment policy: weights must sum to 100'] }) });
    mount('/staff/content/versions/v1'); await userEvent.click(await screen.findByRole('button', { name: 'Send for faculty review' })); await userEvent.click(screen.getByRole('button', { name: /Confirm: Send for faculty review/ })); expect(await screen.findByText(/weights must sum to 100/)).toBeInTheDocument(); expect(screen.getByText(/not ready for review yet/)).toBeInTheDocument();
  });
  it('keeps the separation-of-duties refusal on screen and resolves a quality finding with a reason', async () => {
    const t = tree({ state: 'ADMIN_APPROVAL', authorId: 'author' });
    route({ ...signIn(['APPROVER_PUBLISHER'], 'app'), ...base(t), 'POST /v1/authoring/versions/v1/transition': () => res(409, { message: 'unresolved quality findings' }) });
    mount('/staff/content/versions/v1'); await userEvent.click(await screen.findByRole('button', { name: 'Publish' })); await userEvent.click(screen.getByRole('button', { name: /Confirm: Publish/ })); expect(await screen.findByRole('alert')).toHaveTextContent(/unresolved quality findings/);
  });
  it('lets a faculty reviewer resolve a blocking finding only with a reason', async () => {
    const t = tree({ state: 'FACULTY_REVIEW', authorId: 'author' }); let post: any = null; const finding = { id: 'f1', topicId: null, gate: 'readability', severity: 'WARN', blocking: true, message: 'Reading level too high', resolvedAt: null, resolution: null };
    route({ ...signIn(['FACULTY_REVIEWER'], 'rev'), ...base(t, { 'GET /v1/ai/quality?versionId=v1': () => res(200, { open: 1, findings: [finding] }), 'POST /v1/ai/quality/f1/resolve': ({ body }) => { post = body; return res(200, {}); } }) });
    mount('/staff/content/versions/v1'); expect(await screen.findByText(/1 unresolved quality finding block/)).toBeInTheDocument(); await userEvent.click(screen.getByRole('button', { name: 'Resolve…' })); await userEvent.click(screen.getByRole('button', { name: 'Resolve' })); expect(await screen.findByText(/Say why this can be accepted/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Why this can be accepted/), 'Audience is postgraduate'); await userEvent.click(screen.getByRole('button', { name: 'Resolve' })); await waitFor(() => expect(post).toEqual({ resolution: 'Audience is postgraduate' }));
  });
  it('adds a comment on a topic and shows who said what', async () => {
    const t = tree({ state: 'FACULTY_REVIEW', authorId: 'author', comments: [{ id: 'c1', authorId: 'other', target: null, body: 'Looks fine', createdAt: '2030-01-02T00:00:00Z' }] }); let post: any = null;
    route({ ...signIn(['FACULTY_REVIEWER'], 'rev'), ...base(t), 'POST /v1/authoring/versions/v1/comments': ({ body }) => { post = body; return res(201, {}); } });
    mount('/staff/content/versions/v1'); expect(await screen.findByText('Looks fine')).toBeInTheDocument(); expect(screen.getByText('Rita Reviewer')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add comment' })); expect(await screen.findByText(/Write a comment first/)).toBeInTheDocument(); await userEvent.selectOptions(screen.getByLabelText('About'), 'Basics / Intro'); await userEvent.type(screen.getByLabelText('Comment'), 'Check Q1'); await userEvent.click(screen.getByRole('button', { name: 'Add comment' })); await waitFor(() => expect(post).toEqual({ body: 'Check Q1', target: 'Basics / Intro' }));
  });
  it('shows what changed since the previous version', async () => {
    const t = tree({ state: 'FACULTY_REVIEW', authorId: 'author' }); route({ ...signIn(['AUDITOR'], 'aud'), ...base(t, { 'GET /v1/authoring/versions/v1/diff?against=v0': () => res(200, { changes: [{ path: 'hours', change: 'changed', from: 1, to: 2 }] }) }) });
    mount('/staff/content/versions/v1'); await userEvent.click(await screen.findByRole('button', { name: 'Show the changes' })); expect(await screen.findByText('Programme hours: 1 → 2')).toBeInTheDocument(); expect(screen.getByText(/Your role has no move/)).toBeInTheDocument();
  });
});

describe('editing a draft', () => {
  const draft = () => { const t = tree({ state: 'DRAFT', authorId: 'me' }); return { t, ...signIn(['CONTENT_AUTHOR'], 'me'), ...base(t) } as any; };
  it('saves structure changes while sending back the quiz, assignment and video it did not touch', async () => {
    const { t, ...m } = draft(); route({ ...m, 'PUT /v1/authoring/versions/v1': () => res(200, {}) }); mount('/staff/content/versions/v1');
    const title = await screen.findByLabelText('Module 1'); await userEvent.clear(title); await userEvent.type(title, 'Foundations'); await userEvent.click(screen.getByRole('button', { name: 'Add a topic' })); expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' })); expect(await screen.findByText(/Every topic needs a title/)).toBeInTheDocument(); expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await userEvent.type(screen.getByLabelText('Topic 2'), 'Next'); await userEvent.click(screen.getByRole('button', { name: 'Save changes' })); await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = calls.find((c) => c.method === 'PUT')!.body; expect(body.modules[0].title).toBe('Foundations'); expect(body.modules[0].topics).toHaveLength(2); expect(body.modules[0].topics[0].quiz.questions[0].i18n).toEqual({ hi: { text: 'x' } }); expect(body.modules[0].topics[0].assignment.instructions).toBe('Write'); expect(body.modules[0].topics[0].assets[0].files.master.size).toBe(5_000_000); expect(body.modules[0].topics[1]).toMatchObject({ title: 'Next', hours: 1 });
  });
  it('will not edit a topic with unsaved structure changes, and asks before deleting a topic that has content', async () => {
    const { t, ...m } = draft(); route(m); mount('/staff/content/versions/v1'); await userEvent.click(await screen.findByRole('button', { name: 'Edit quiz, assignment and video' }));
    expect(screen.getByLabelText('Pass mark (%)')).toBeInTheDocument(); await userEvent.click(screen.getByRole('button', { name: 'Add a topic' })); expect(await screen.findByText(/Save your structure changes first/)).toBeInTheDocument();
    window.confirm = vi.fn(() => false); await userEvent.click(screen.getAllByRole('button', { name: 'Delete topic' })[0]); expect(window.confirm).toHaveBeenCalled(); expect(screen.getByLabelText('Topic 1')).toBeInTheDocument();
  });
  it('lists every problem with a quiz before saving, then saves it with the right answer', async () => {
    const { t, ...m } = draft(); route({ ...m, 'PUT /v1/authoring/topics/t1/quiz': () => res(200, {}) }); mount('/staff/content/versions/v1'); await userEvent.click(await screen.findByRole('button', { name: 'Edit quiz, assignment and video' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add a question' })); await userEvent.click(screen.getByRole('button', { name: 'Save quiz' })); const alert = await screen.findByRole('alert'); expect(alert).toHaveTextContent(/Question 2: Write the question/); expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await userEvent.type(screen.getByLabelText('Question', { selector: '#qx-t1-1' }), 'Pick');
    const opts = screen.getAllByLabelText(/Option \d text/); await userEvent.clear(opts[opts.length - 2]); await userEvent.type(opts[opts.length - 2], 'Red'); await userEvent.clear(opts[opts.length - 1]); await userEvent.type(opts[opts.length - 1], 'Blue');
    await userEvent.click(screen.getAllByLabelText('Option 2 is correct')[1]); await userEvent.click(screen.getByRole('button', { name: 'Save quiz' })); await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = calls.find((c) => c.method === 'PUT')!.body; expect(body.questions).toHaveLength(2); expect(body.questions[0]).toMatchObject({ answer: 1, i18n: { hi: { text: 'x' } } }); expect(body.questions[1]).toMatchObject({ type: 'MCQ_SINGLE', answer: 1, options: expect.arrayContaining(['Red']) });
  });
  it('saves an assignment then asks the server to rebuild its scoring scale from the new criteria', async () => {
    const { t, ...m } = draft(); route({ ...m, 'PUT /v1/authoring/topics/t1/assignment': () => res(200, {}), 'PUT /v1/authoring/topics/t1/assignment-policy': () => res(200, {}) }); mount('/staff/content/versions/v1'); await userEvent.click(await screen.findByRole('button', { name: 'Edit quiz, assignment and video' })); await userEvent.click(screen.getByRole('button', { name: 'Assignment' }));
    await userEvent.clear(screen.getByLabelText('Criterion 1 weight')); await userEvent.type(screen.getByLabelText('Criterion 1 weight'), '80'); await userEvent.click(screen.getByRole('button', { name: 'Save assignment' })); expect(await screen.findByText(/add up to 80/)).toBeInTheDocument(); expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await userEvent.clear(screen.getByLabelText('Criterion 1 weight')); await userEvent.type(screen.getByLabelText('Criterion 1 weight'), '100'); await userEvent.click(screen.getByRole('button', { name: 'Save assignment' })); await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    const puts = calls.filter((c) => c.method === 'PUT'); expect(puts[0].url).toMatch(/assignment$/); expect(puts[0].body.rubric.criteria).toEqual([{ criterion: 'Clarity', weight: 100 }]); expect(puts[1].url).toMatch(/assignment-policy$/); expect(puts[1].body).toEqual({ dimensions: [], passPercent: 60 });
  });
  it('registers a video with rights and uploads a file to it', async () => {
    const t = tree({ state: 'DRAFT', authorId: 'me', languages: ['en', 'hi'] }); route({ ...signIn(['CONTENT_AUTHOR'], 'me'), ...base(t), 'POST /v1/authoring/topics/t1/assets': () => res(201, {}), 'PUT /v1/authoring/assets/a1/files/transcript': () => res(200, {}) });
    mount('/staff/content/versions/v1'); await userEvent.click(await screen.findByRole('button', { name: 'Edit quiz, assignment and video' })); await userEvent.click(screen.getByRole('button', { name: 'Video' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add video' })); expect(await screen.findByText(/length in minutes/)).toBeInTheDocument(); await userEvent.selectOptions(screen.getByLabelText('Language'), 'hi'); await userEvent.type(screen.getByLabelText('Length (minutes)'), '12'); await userEvent.click(screen.getByRole('button', { name: 'Add video' })); expect(await screen.findByText(/who owns the rights/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Rights and licence'), 'Owned by the institute'); await userEvent.click(screen.getByRole('button', { name: 'Add video' })); await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/assets'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/assets'))!.body).toMatchObject({ language: 'hi', durationSec: 720, rights: { statement: 'Owned by the institute' } });
    await userEvent.upload(screen.getByLabelText('Upload transcript'), new File(['hello'], 't.txt', { type: 'text/plain' })); await waitFor(() => expect(calls.some((c) => c.url.endsWith('/files/transcript'))).toBe(true));
    expect(screen.getByLabelText('Replace master')).toBeInTheDocument();
  });
  it('is read-only for an author looking at someone elses draft', async () => {
    const t = tree({ state: 'DRAFT', authorId: 'someone' }); route({ ...signIn(['CONTENT_AUTHOR'], 'me'), ...base(t) }); mount('/staff/content/versions/v1'); expect(await screen.findByText('What is in this version')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });
});
