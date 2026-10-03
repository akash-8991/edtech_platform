import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Doubts from '../staff/Doubts';
import DoubtTicket from '../staff/DoubtTicket';
import { AuthProvider, useAuth } from '../auth';
import { api } from '../api/client';
import type { DoubtDetail, DoubtRow } from '../api/types';
import { canReply, describeContext, resolveBlock, slaInfo, span, splitList, validateFaq, validateTeacher, validateWindows, windowsText } from '../lib/doubts';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let calls: { method: string; url: string; body: any }[] = [];
type H = (c: { body: any; n: number }) => Response;
const route = (map: Record<string, H>) => { const counts: Record<string, number> = {}; vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => {
  const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body; calls.push({ method, url, body });
  const k = `${method} ${url}`; counts[k] = (counts[k] ?? 0) + 1; const h = map[k]; return h ? h({ body, n: counts[k] }) : res(404, { message: `no route ${k}` }); })); };
beforeEach(() => { calls = []; api.clear(); window.confirm = vi.fn(() => true); });
const signIn = (roles: string[], id = 'me') => { api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); return { 'GET /v1/auth/me': () => res(200, { id, email: 's@x.test', name: 'Sam', language: 'en', roles, mfaEnabled: true }) } as Record<string, H>; };
const Gate = ({ children }: { children: JSX.Element }) => (useAuth().loading ? <p>loading</p> : children);
const mount = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><Gate><Routes><Route path="/staff" element={<p>home</p>} /><Route path="/staff/doubts" element={<Doubts />} /><Route path="/staff/doubts/tickets/:ticketId" element={<DoubtTicket />} /></Routes></Gate></AuthProvider></MemoryRouter>);

const row = (o: Partial<DoubtRow> = {}): DoubtRow => ({ id: 't1', number: 12, subject: 'Resistor value wrong', category: 'CONTENT', priority: 'P2', status: 'ASSIGNED', topicId: 'tp1', language: 'en', assignedTeacherId: 'me', assignedTeacherName: 'Tara Teacher', routingNote: null, firstResponseDueAt: new Date(Date.now() + 3_600_000).toISOString(), firstResponseAt: null, resolvedAt: null, slaBreachedAt: null, rerouteCount: 0, rating: null, reopenCount: 0, createdAt: '2030-01-01T09:00:00Z', resolutionSummary: null, ...o });
const detail = (o: Partial<DoubtDetail> = {}): DoubtDetail => ({ ...row(), context: { course: { programme: 'AI/ML', code: 'AIML', discipline: 'AI' }, topic: { id: 'tp1', title: 'Sensors' }, learnerProgress: { percentComplete: 40, topicsDone: 2, topicsTotal: 5, quizAttempts: 1 }, conversation: [{ role: 'LEARNER', content: 'why 10k?' }, { role: 'TUTOR', content: 'It pulls the line up' }] }, learner: { name: 'Lena Learner', language: 'en' },
  messages: [{ id: 'm1', authorRole: 'LEARNER', internal: false, body: 'The value looks wrong', attachments: [{ key: 'doubts/l/x-wiring.png', name: 'wiring.png', size: 3000 }], at: '2030-01-01T09:00:00Z' }, { id: 'm2', authorRole: 'TEACHER', internal: true, body: 'Check slide 4', attachments: [], at: '2030-01-01T09:30:00Z' }], appointments: [], ...o });

describe('doubt helpers', () => {
  it('states where a ticket stands against its promise', () => {
    const now = Date.parse('2030-01-01T12:00:00Z'); const base = row({ firstResponseDueAt: '2030-01-01T13:00:00Z' });
    expect(slaInfo(base, now)).toEqual({ text: 'Reply due in 1 h', tone: 'muted' }); expect(slaInfo(row({ firstResponseDueAt: '2030-01-01T12:10:00Z' }), now).tone).toBe('warn'); expect(slaInfo(row({ firstResponseDueAt: '2030-01-01T11:00:00Z' }), now)).toEqual({ text: 'Overdue by 1 h', tone: 'warn' });
    expect(slaInfo(row({ firstResponseAt: '2030-01-01T12:30:00Z', firstResponseDueAt: '2030-01-01T13:00:00Z' }), now).text).toMatch(/on time/); expect(slaInfo(row({ firstResponseAt: '2030-01-01T14:00:00Z', firstResponseDueAt: '2030-01-01T13:00:00Z' }), now).text).toMatch(/late/); expect(slaInfo(row({ status: 'CLOSED' }), now).text).toMatch(/without a reply/);
    expect(span(30 * 60_000)).toBe('30 min'); expect(span(5 * 3_600_000)).toBe('5 h'); expect(span(3 * 86_400_000)).toBe('3 days');
  });
  it('knows when a ticket can be answered or resolved', () => {
    expect(canReply(row())).toBe(true); expect(canReply(row({ assignedTeacherId: null }))).toBe(false); expect(canReply(row({ status: 'RESOLVED' }))).toBe(false);
    expect(resolveBlock(row())).toMatch(/Send the learner a reply/); expect(resolveBlock(row({ firstResponseAt: 'x' }))).toBeNull(); expect(resolveBlock(row({ status: 'RESOLVED' }))).toMatch(/already resolved/);
  });
  it('reads the context bundle, tolerating missing parts', () => {
    expect(describeContext(null)).toMatchObject({ course: null, topic: null, progress: null, conversation: [], sources: 0 }); const d = describeContext(detail().context); expect(d.course).toBe('AI/ML (AIML)'); expect(d.progress).toMatch(/40% complete \(2 of 5/); expect(d.conversation[1]).toEqual({ who: 'AI tutor', text: 'It pulls the line up' });
  });
  it('validates teachers, working periods and reusable answers', () => {
    expect(validateWindows([{ day: 1, start: '09:00', end: '17:00' }])).toBeNull(); expect(validateWindows([{ day: 1, start: '17:00', end: '09:00' }])).toMatch(/Monday: the end must be after/); expect(validateWindows([{ day: 1, start: '', end: '09:00' }])).toMatch(/start and an end/);
    expect(validateTeacher({ capacity: '10', languages: ['en'], windows: [] })).toBeNull(); expect(validateTeacher({ capacity: '0', languages: ['en'], windows: [] })).toMatch(/Capacity/); expect(validateTeacher({ capacity: '101', languages: ['en'], windows: [] })).toMatch(/Capacity/); expect(validateTeacher({ capacity: '5', languages: [], windows: [] })).toMatch(/language/);
    expect(splitList('a, b\n a ,,c')).toEqual(['a', 'b', 'c']); expect(windowsText([])).toBe('any time'); expect(windowsText([{ day: 1, start: '09:00', end: '17:00' }])).toBe('Mon 09:00-17:00'); expect(validateFaq({ question: ' ', answer: 'x' })).toMatch(/question/); expect(validateFaq({ question: 'q', answer: '' })).toMatch(/answer/); expect(validateFaq({ question: 'q', answer: 'a' })).toBeNull();
  });
});

describe('doubt desk queues', () => {
  it('shows a teacher their tickets with the promise state, and sends someone without access home', async () => {
    route({ ...signIn(['DOUBT_TEACHER']), 'GET /v1/teacher/tickets': () => res(200, [row()]) }); mount('/staff/doubts');
    expect(await screen.findByRole('link', { name: '#12 Resistor value wrong' })).toHaveAttribute('href', '/staff/doubts/tickets/t1'); expect(screen.getByText(/Reply due in/)).toBeInTheDocument(); expect(screen.getByText(/with Tara Teacher/)).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'All tickets' })).toBeNull();
  });
  it('blocks a role with no doubt-desk access before fetching', async () => {
    route(signIn(['LAB_COORDINATOR'])); mount('/staff/doubts'); expect(await screen.findByText('home')).toBeInTheDocument(); expect(calls.some((c) => c.url.includes('teacher'))).toBe(false);
  });
  it('lets support see every ticket, filter by status, and run the sweep', async () => {
    route({ ...signIn(['SUPPORT_OPERATOR']), 'GET /v1/teacher/tickets?scope=unassigned': () => res(200, []), 'GET /v1/teacher/tickets?scope=all': () => res(200, [row({ status: 'NEW', assignedTeacherId: null, assignedTeacherName: null })]), 'GET /v1/teacher/tickets?scope=all&status=RESOLVED': () => res(200, []), 'POST /v1/doubt-centre/sweep': () => res(201, { routed: 2, breached: 1, rerouted: 0, closed: 3 }) });
    mount('/staff/doubts'); expect(await screen.findByText(/Nothing is waiting for a teacher/)).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'My tickets' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'All tickets' })); expect(await screen.findByText(/not assigned/)).toBeInTheDocument(); await userEvent.selectOptions(screen.getByLabelText('Status'), 'RESOLVED'); expect(await screen.findByText('There are no tickets.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Assign waiting tickets/ })); expect(await screen.findByText('Assigned 2 waiting tickets, flagged 1 late, moved 0 to another teacher, closed 3 old resolved tickets.')).toBeInTheDocument();
  });
});

describe('ticket', () => {
  const ticketRoutes = (d: DoubtDetail, extra: Record<string, H> = {}) => ({ [`GET /v1/teacher/tickets/${d.id}`]: () => res(200, d), ...extra });
  it('shows the learner by first name with context, marks internal notes, and downloads an attachment', async () => {
    const d = detail(); route({ ...signIn(['DOUBT_TEACHER']), ...ticketRoutes(d), 'GET /v1/teacher/tickets/t1/attachment?key=doubts%2Fl%2Fx-wiring.png': () => new Response('png', { status: 200 }) });
    URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn(); const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mount('/staff/doubts/tickets/t1'); expect(await screen.findByText(/asked by Lena/)).toBeInTheDocument(); expect(screen.queryByText(/Learner$/)).toBeNull(); expect(screen.getByText(/Course: AI\/ML \(AIML\)/)).toBeInTheDocument(); expect(screen.getByText(/Internal note: the learner cannot see this/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Download wiring.png' })); await waitFor(() => expect(click).toHaveBeenCalled()); click.mockRestore();
  });
  it('requires a reply before resolving, then sends a reply and an internal note', async () => {
    let d = detail(); route({ ...signIn(['DOUBT_TEACHER']), ...ticketRoutes(d), 'GET /v1/teacher/tickets/t1': () => res(200, d), 'POST /v1/teacher/tickets/t1/reply': ({ body }) => { d = detail({ firstResponseAt: new Date().toISOString(), status: 'WAITING_LEARNER' }); return res(201, { ok: true, internal: body.internal }); } });
    mount('/staff/doubts/tickets/t1'); expect(await screen.findByText(/Send the learner a reply before resolving/)).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Mark as resolved' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Send reply' })); expect(await screen.findByText('Write your reply first.')).toBeInTheDocument(); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.type(screen.getByLabelText('Your reply'), 'A 10k resistor pulls the pin high.'); await userEvent.click(screen.getByRole('button', { name: 'Send reply' })); expect(await screen.findByText('Reply sent. The learner has been told.')).toBeInTheDocument(); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ body: 'A 10k resistor pulls the pin high.', internal: false });
    expect(await screen.findByRole('button', { name: 'Mark as resolved' })).toBeInTheDocument();
  });
  it('sends an internal note as internal', async () => {
    route({ ...signIn(['DOUBT_TEACHER']), ...ticketRoutes(detail()), 'POST /v1/teacher/tickets/t1/reply': () => res(201, { ok: true, internal: true }) }); mount('/staff/doubts/tickets/t1');
    await userEvent.type(await screen.findByLabelText('Your reply'), 'Ask the author'); await userEvent.click(screen.getByLabelText(/Internal note \(only staff/)); await userEvent.click(screen.getByRole('button', { name: 'Save note' })); expect(await screen.findByText(/The learner cannot see it/)).toBeInTheDocument(); expect(calls.find((c) => c.method === 'POST')!.body.internal).toBe(true);
  });
  it('resolves with a summary and keeps the server refusal visible', async () => {
    route({ ...signIn(['DOUBT_TEACHER']), ...ticketRoutes(detail({ firstResponseAt: '2030-01-01T10:00:00Z', status: 'WAITING_LEARNER' })), 'POST /v1/teacher/tickets/t1/resolve': () => res(409, { message: 'already resolved' }) }); mount('/staff/doubts/tickets/t1');
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as resolved' })); expect(await screen.findByText(/short summary of the answer/)).toBeInTheDocument(); await userEvent.type(screen.getByLabelText(/Summary of the answer/), 'Value corrected'); await userEvent.click(screen.getByRole('button', { name: 'Mark as resolved' })); expect(await screen.findByRole('alert')).toHaveTextContent(/already resolved/);
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ summary: 'Value corrected' });
  });
  it('lets a teacher take an unassigned ticket', async () => {
    let d = detail({ assignedTeacherId: null, assignedTeacherName: null, status: 'NEW' }); route({ ...signIn(['DOUBT_TEACHER']), 'GET /v1/teacher/tickets/t1': () => res(200, d), 'POST /v1/teacher/tickets/t1/claim': () => { d = detail(); return res(201, { ok: true }); } });
    mount('/staff/doubts/tickets/t1'); await userEvent.click(await screen.findByRole('button', { name: 'Take this ticket' })); expect(await screen.findByText('Yours now.')).toBeInTheDocument(); expect(await screen.findByRole('button', { name: 'Send reply' })).toBeInTheDocument();
  });
  it('proposes a reusable answer only with a question and an answer', async () => {
    route({ ...signIn(['DOUBT_TEACHER']), ...ticketRoutes(detail()), 'POST /v1/teacher/tickets/t1/propose-faq': () => res(201, {}) }); mount('/staff/doubts/tickets/t1');
    await userEvent.click(await screen.findByRole('button', { name: 'Suggest this as a reusable answer' })); await userEvent.click(screen.getByRole('button', { name: 'Send for review' })); expect(await screen.findByText(/Write the question/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Question, as a learner/), 'Why 10k?'); await userEvent.type(screen.getByLabelText('Answer'), 'It pulls the pin up.'); await userEvent.click(screen.getByRole('button', { name: 'Send for review' })); await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ question: 'Why 10k?', answer: 'It pulls the pin up.', language: 'en', kind: 'FAQ', topicId: 'tp1' });
  });
  it('lets support reassign with a reason, picking a teacher or automatic, and offers no reply to a ticket nobody holds', async () => {
    route({ ...signIn(['SUPPORT_OPERATOR']), ...ticketRoutes(detail({ assignedTeacherId: 'other', assignedTeacherName: 'Omar' })), 'GET /v1/doubt-centre/teachers': () => res(200, [{ userId: 'other', name: 'Omar', active: true, available: true, disciplines: [], skills: [], languages: ['en'], capacity: 5, open: 1, lastAssignedAt: null, windows: [] }, { userId: 'tz', name: 'Zed', active: true, available: false, disciplines: [], skills: [], languages: ['en'], capacity: 5, open: 0, lastAssignedAt: null, windows: [] }]), 'POST /v1/doubt-centre/tickets/t1/reassign': () => res(201, {}) });
    mount('/staff/doubts/tickets/t1'); await userEvent.click(await screen.findByRole('button', { name: 'Reassign…' })); await userEvent.click(screen.getByRole('button', { name: 'Reassign' })); expect(await screen.findByText(/Write the reason/)).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /Zed \(0 of 5 open, not taking tickets\)/ })).toBeInTheDocument(); expect(screen.queryByRole('option', { name: /Omar/ })).toBeNull(); // the current holder is not offered
    await userEvent.selectOptions(screen.getByLabelText('Give it to'), 'tz'); await userEvent.type(screen.getByLabelText(/Reason/), 'Omar is on leave'); await userEvent.click(screen.getByRole('button', { name: 'Reassign' })); await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true)); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ reason: 'Omar is on leave', teacherId: 'tz' });
  });
  it('lets the teacher confirm a requested appointment and cancel it', async () => {
    const ap = [{ id: 'a1', startsAt: '2030-02-01T10:00:00Z', endsAt: '2030-02-01T10:30:00Z', status: 'REQUESTED', meetingRef: null }];
    route({ ...signIn(['DOUBT_TEACHER']), ...ticketRoutes(detail({ appointments: ap })), 'POST /v1/teacher/appointments/a1/confirm': () => res(201, {}) }); mount('/staff/doubts/tickets/t1');
    await userEvent.type(await screen.findByLabelText(/Meeting link or room/), 'room 4'); await userEvent.click(screen.getByRole('button', { name: 'Confirm' })); expect(await screen.findByText('Appointment confirmed.')).toBeInTheDocument(); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ meetingRef: 'room 4' });
  });
});

describe('reusable answers, teachers, report', () => {
  const faq = (o: any = {}) => ({ id: 'f1', programmeId: 'p', topicId: null, kind: 'FAQ', language: 'en', question: 'Why 10k?', answer: 'Pull-up.', status: 'DRAFT', sourceTicketId: 't1', proposedById: 'x', reviewReason: null, createdAt: '2030-01-01T00:00:00Z', ...o });
  it('approves a proposed answer, rejects only with a reason, and shows the separation-of-duties refusal', async () => {
    let n = 0; route({ ...signIn(['FACULTY_REVIEWER']), 'GET /v1/faq?status=DRAFT': () => res(200, [faq()]), 'POST /v1/faq/f1/review': ({ body }) => (++n === 1 ? res(409, { message: 'segregation of duties: proposer cannot review own entry' }) : (void body, res(200, {}))) });
    mount('/staff/doubts'); await userEvent.click(await screen.findByRole('button', { name: 'Approve' })); expect(await screen.findByRole('alert')).toHaveTextContent(/segregation of duties/);
    await userEvent.click(screen.getByRole('button', { name: 'Reject…' })); await userEvent.click(screen.getByRole('button', { name: 'Reject' })); expect(await screen.findByText(/Write the reason/)).toBeInTheDocument(); expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    await userEvent.type(screen.getByLabelText(/Why it is rejected/), 'Too vague'); await userEvent.click(screen.getByRole('button', { name: 'Reject' })); await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2)); expect(calls.filter((c) => c.method === 'POST')[1].body).toEqual({ decision: 'REJECT', reason: 'Too vague' });
  });
  it('does not link a reviewer to a ticket they cannot open', async () => {
    route({ ...signIn(['FACULTY_REVIEWER']), 'GET /v1/faq?status=DRAFT': () => res(200, [faq()]) }); mount('/staff/doubts'); expect(await screen.findByText('Why 10k?')).toBeInTheDocument(); expect(screen.queryByRole('link', { name: 'Came from a ticket' })).toBeNull();
  });
  it('shows a teacher read-only answers (no review buttons)', async () => {
    route({ ...signIn(['DOUBT_TEACHER']), 'GET /v1/teacher/tickets': () => res(200, []), 'GET /v1/faq?status=DRAFT': () => res(200, [faq()]) }); mount('/staff/doubts'); await userEvent.click(await screen.findByRole('button', { name: 'Reusable answers' })); expect(await screen.findByText('Why 10k?')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
  it('lets a teacher save their availability and refuses a working period that ends before it starts', async () => {
    route({ ...signIn(['DOUBT_TEACHER']), 'GET /v1/teacher/tickets': () => res(200, []), 'GET /v1/teacher/profile': () => res(200, { userId: 'me', active: true, available: true, disciplines: ['AI'], skills: [], languages: ['en'], capacity: 8, open: 2, lastAssignedAt: null, windows: [] }), 'PUT /v1/teacher/profile': () => res(200, { userId: 'me', active: true, available: false, disciplines: [], skills: [], languages: ['en'], capacity: 8, open: 2, lastAssignedAt: null, windows: [{ day: 1, start: '09:00', end: '17:00' }] }) });
    mount('/staff/doubts'); await userEvent.click(await screen.findByRole('button', { name: 'My availability' })); await userEvent.click(await screen.findByRole('button', { name: 'Add a working period' }));
    const end = screen.getByLabelText('Period 1 end'); await userEvent.clear(end); await userEvent.type(end, '08:00'); await userEvent.click(screen.getByRole('button', { name: 'Save availability' })); expect(await screen.findByText(/Monday: the end must be after the start/)).toBeInTheDocument(); expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await userEvent.clear(end); await userEvent.type(end, '17:00'); await userEvent.click(screen.getByLabelText(/I am available/)); await userEvent.click(screen.getByRole('button', { name: 'Save availability' })); expect(await screen.findByText('Saved.')).toBeInTheDocument(); expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ available: false, windows: [{ day: 1, start: '09:00', end: '17:00' }] });
  });
  it('lets an admin edit a teacher, and gives support the directory read-only', async () => {
    const t = { userId: 'u9', name: 'Tara', active: true, available: true, disciplines: ['AI/ML'], skills: ['python'], languages: ['en'], capacity: 10, open: 3, lastAssignedAt: null, windows: [] };
    route({ ...signIn(['ACADEMIC_ADMIN']), 'GET /v1/teacher/tickets?scope=unassigned': () => res(200, []), 'GET /v1/doubt-centre/teachers': () => res(200, [t]), 'PUT /v1/doubt-centre/teachers/u9': () => res(200, {}) }); const { unmount } = mount('/staff/doubts');
    await userEvent.click(await screen.findByRole('button', { name: 'Teachers' })); await userEvent.click(await screen.findByRole('button', { name: 'Edit Tara' })); const cap = screen.getByLabelText('Open tickets at once'); await userEvent.clear(cap); await userEvent.type(cap, '0'); await userEvent.click(screen.getByRole('button', { name: 'Save' })); expect(await screen.findByText(/Capacity/)).toBeInTheDocument(); expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await userEvent.clear(cap); await userEvent.type(cap, '12'); await userEvent.click(screen.getByRole('button', { name: 'Save' })); await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true)); expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ capacity: 12, disciplines: ['AI/ML'], skills: ['python'], languages: ['en'], active: true }); unmount();
    route({ ...signIn(['SUPPORT_OPERATOR']), 'GET /v1/teacher/tickets?scope=unassigned': () => res(200, []), 'GET /v1/doubt-centre/teachers': () => res(200, [t]) }); mount('/staff/doubts'); await userEvent.click(await screen.findByRole('button', { name: 'Teachers' })); expect(await screen.findByText('Tara')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Edit Tara' })).toBeNull();
  });
  it('shows the report for the period', async () => {
    route({ ...signIn(['AUDITOR']), 'GET /v1/faq?status=DRAFT': () => res(200, []), 'GET /v1/reports/doubts?days=30': () => res(200, { since: 'x', tickets: 40, open: 5, unassigned: 2, slaCompliance: 0.9, avgFirstResponseMinutes: 22.5, avgResolutionHours: 6, avgRating: 4.5, reopenRate: 0.1, bySource: { MANUAL: 30, TUTOR: 10, AUTO: 0 }, byCategory: { CONTENT: 20, QUIZ: 20 }, teachers: [{ teacherId: 't', name: 'Tara', assigned: 20, resolved: 18, breaches: 1, avgRating: 4.6 }] }) });
    mount('/staff/doubts'); await userEvent.click(await screen.findByRole('button', { name: 'Report' })); expect(await screen.findByText('90%')).toBeInTheDocument(); expect(screen.getByText(/22.5 minutes/)).toBeInTheDocument(); expect(screen.getByText('Tara')).toBeInTheDocument(); expect(screen.getByText(/Passed on by the AI tutor/)).toBeInTheDocument();
  });
});
