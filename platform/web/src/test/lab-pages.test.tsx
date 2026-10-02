import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Labs from '../pages/Labs';
import LabDetail from '../pages/LabDetail';
import LabAttend from '../pages/LabAttend';
import { api } from '../api/client';
import { attendanceWindow, blockers, labStatus, liveBooking, looksLikeUrl, tokenFromInput } from '../lib/labs';
import { notificationLink, notificationText } from '../lib/format';
import type { LabActivity } from '../api/types';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let calls: { method: string; url: string; headers: any; body: any }[] = [];
type H = (c: { body: any; headers: any; n: number }) => Response;
const route = (map: Record<string, H>) => { const counts: Record<string, number> = {}; vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => {
  const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body; calls.push({ method, url, headers: init?.headers ?? {}, body });
  const k = `${method} ${url}`; counts[k] = (counts[k] ?? 0) + 1; const h = map[k]; return h ? h({ body, headers: init?.headers ?? {}, n: counts[k] }) : res(404, { message: `no route ${k}` }); })); };
beforeEach(() => { calls = []; api.clear(); api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); });

const iso = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const lab = (o: Partial<LabActivity> = {}): LabActivity => ({ activityId: 'L1', code: 'LAB1', title: 'Soldering basics', mandatory: true, location: 'Workshop 2', manual: 'Wear gloves. Steps are in the handout.', safetyText: 'I will wear eye protection and follow the instructor.', safetyHash: 'H1', requireEvidence: true,
  eligibility: { eligible: true, missingPrerequisiteTopics: [], safetyAcknowledged: true }, bookings: [], completed: false, ...o });
const slot = (o: any = {}) => ({ id: 'S1', batchCode: 'B1', startsAt: iso(60 * 48), endsAt: iso(60 * 50), location: 'Workshop 2', capacity: 10, seatsLeft: 3, ...o });
const booking = (o: any = {}) => ({ id: 'BK1', slotId: 'S1', status: 'BOOKED', completed: false, evidenceSubmitted: false, slot: { startsAt: iso(60 * 48), endsAt: iso(60 * 50), location: 'Workshop 2', batchCode: 'B1', cancelled: false }, ...o });
const detail = (map: Record<string, H>) => route({ 'GET /v1/me/entitlements': () => res(200, [{ id: 'E1', learningAccess: true }]), 'GET /v1/me/entitlements/E1/progress': () => res(200, { entitlementId: 'E1', percentComplete: 0, topics: [{ topicId: 'T1', title: 'Circuits' }] }), ...map });
const open = () => render(<MemoryRouter initialEntries={['/labs/L1']}><Routes><Route path="/labs/:activityId" element={<LabDetail />} /></Routes></MemoryRouter>);

describe('lab helpers', () => {
  it('derives one clear status per lab, ignoring cancelled bookings', () => {
    expect(labStatus(lab({ completed: true })).state).toBe('completed'); expect(labStatus(lab({ bookings: [booking({ status: 'ATTENDED' })] })).state).toBe('awaiting-evidence'); expect(labStatus(lab({ requireEvidence: false, bookings: [booking({ status: 'ATTENDED' })] })).state).toBe('attended');
    expect(labStatus(lab({ bookings: [booking({ status: 'ATTENDED', evidenceSubmitted: true })] })).state).toBe('attended'); expect(labStatus(lab({ bookings: [booking()] })).state).toBe('booked'); expect(labStatus(lab({ bookings: [booking({ status: 'CANCELLED' })] })).state).toBe('ready');
    expect(labStatus(lab({ eligibility: { eligible: false, missingPrerequisiteTopics: ['T1'], safetyAcknowledged: false } })).state).toBe('blocked'); expect(liveBooking(lab({ bookings: [booking({ status: 'NO_SHOW' })] }))).toBeUndefined();
  });
  it('lists what is missing in plain words using topic titles', () => {
    const l = lab({ eligibility: { eligible: false, missingPrerequisiteTopics: ['T1', 'T9'], safetyAcknowledged: false } }); expect(blockers(l, new Map([['T1', 'Circuits']]))).toEqual(['Complete the topic "Circuits" first.', 'Complete the topic "a prerequisite topic" first.', 'Read and accept the safety notice.']);
  });
  it('explains the check-in window: not yet, open, over', () => {
    expect(attendanceWindow({ startsAt: iso(120), endsAt: iso(180) })).toMatchObject({ open: false, text: expect.stringContaining('opens at') }); expect(attendanceWindow({ startsAt: iso(10), endsAt: iso(70) }).open).toBe(true);
    expect(attendanceWindow({ startsAt: iso(-90), endsAt: iso(-30) })).toEqual({ open: false, text: 'This session has ended.' }); expect(attendanceWindow({ startsAt: 'x', endsAt: 'y' }).open).toBe(false);
  });
  it('accepts a bare code or the whole QR link', () => { expect(tokenFromInput(' abc.def ')).toBe('abc.def'); expect(tokenFromInput('https://learn.example/labs/attend?token=xyz.123')).toBe('xyz.123'); expect(tokenFromInput('')).toBe(''); expect(looksLikeUrl('https://x.org/m.pdf')).toBe(true); expect(looksLikeUrl('see handout')).toBe(false); });
  it('maps lab notifications to the labs page', () => { expect(notificationLink('lab.booked', { bookingId: 'b' })).toBe('/labs'); expect(notificationText('lab.slot_cancelled')).toMatch(/cancelled/); expect(notificationLink('privacy.export_ready', {})).toBe('/privacy'); expect(notificationText('privacy.export_ready')).toMatch(/ready/); });
});

describe('Labs list', () => {
  it('shows each lab with its status, your session and what is blocking you', async () => {
    route({ 'GET /v1/me/labs': () => res(200, [lab({ bookings: [booking()] }), lab({ activityId: 'L2', title: 'Oscilloscope', eligibility: { eligible: false, missingPrerequisiteTopics: ['T1'], safetyAcknowledged: false } }), lab({ activityId: 'L3', title: 'Safety induction', completed: true, mandatory: false })]),
      'GET /v1/me/entitlements': () => res(200, [{ id: 'E1', learningAccess: true }]), 'GET /v1/me/entitlements/E1/progress': () => res(200, { entitlementId: 'E1', percentComplete: 0, topics: [{ topicId: 'T1', title: 'Circuits' }] }) });
    render(<MemoryRouter><Labs /></MemoryRouter>); expect(await screen.findByRole('link', { name: 'Soldering basics' })).toHaveAttribute('href', '/labs/L1'); expect(screen.getByText('Booked')).toBeInTheDocument(); expect(screen.getByText(/Your session:/)).toBeInTheDocument();
    expect(screen.getByText('Not ready yet')).toBeInTheDocument(); expect(screen.getByText('Complete the topic "Circuits" first.')).toBeInTheDocument(); expect(screen.getByText('Read and accept the safety notice.')).toBeInTheDocument(); expect(screen.getByText('Completed')).toBeInTheDocument(); expect(screen.getByText(/1 of 3 completed/)).toBeInTheDocument();
  });
  it('has an empty state', async () => { route({ 'GET /v1/me/labs': () => res(200, []), 'GET /v1/me/entitlements': () => res(200, []) }); render(<MemoryRouter><Labs /></MemoryRouter>); expect(await screen.findByText(/no lab sessions/)).toBeInTheDocument(); });
});

describe('LabDetail: acknowledge, book, cancel', () => {
  it('requires the safety notice first, sends the notice hash, then allows booking with a retry-safe key', async () => {
    let acked = false; let booked = false;
    detail({ 'GET /v1/me/labs': () => res(200, [lab({ eligibility: { eligible: acked, missingPrerequisiteTopics: [], safetyAcknowledged: acked }, bookings: booked ? [booking()] : [] })]), 'GET /v1/labs/slots?activityId=L1': () => res(200, [slot()]),
      'POST /v1/labs/activities/L1/ack': () => { acked = true; return res(201, { ok: true }); }, 'POST /v1/labs/slots/S1/book': () => { booked = true; return res(201, { id: 'BK1' }); } });
    const u = userEvent.setup(); open(); const book = await screen.findByRole('button', { name: 'Book' }); expect(book).toBeDisabled(); expect(screen.getByText(/Read and accept the safety notice/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: /I have read and understood/ })); expect(await screen.findByText('Safety notice accepted.')).toBeInTheDocument(); expect(calls.find((c) => c.url.endsWith('/ack'))!.body).toEqual({ textHash: 'H1' });
    await u.click(await screen.findByRole('button', { name: 'Book' })); expect(await screen.findByText('Your booking')).toBeInTheDocument(); expect(calls.find((c) => c.url.endsWith('/book'))!.headers['Idempotency-Key']).toBeTruthy(); expect(screen.getByText('Check in at the lab')).toBeInTheDocument();
  });
  it('shows a full session as full, and the server reason when a booking is refused (then refreshes the seats)', async () => {
    let n = 0; detail({ 'GET /v1/me/labs': () => res(200, [lab()]), 'GET /v1/labs/slots?activityId=L1': () => res(200, [slot({ seatsLeft: n++ === 0 ? 1 : 0 }), slot({ id: 'S2', seatsLeft: 0 })]), 'POST /v1/labs/slots/S1/book': () => res(409, { message: 'slot is full' }) });
    const u = userEvent.setup(); open(); const btns = await screen.findAllByRole('button', { name: 'Book' }); expect(btns[1]).toBeDisabled(); expect(screen.getAllByText('Full').length).toBeGreaterThan(0); await u.click(btns[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent('slot is full'); await waitFor(() => expect(screen.getAllByRole('button', { name: 'Book' })[0]).toBeDisabled());
  });
  it('turns the server\'s not_eligible reply into a friendly message', async () => {
    detail({ 'GET /v1/me/labs': () => res(200, [lab()]), 'GET /v1/labs/slots?activityId=L1': () => res(200, [slot()]), 'POST /v1/labs/slots/S1/book': () => res(409, { error: 'not_eligible', missingPrerequisiteTopics: ['T1'] }) });
    const u = userEvent.setup(); open(); await u.click(await screen.findByRole('button', { name: 'Book' })); expect(await screen.findByRole('alert')).toHaveTextContent(/finish the steps listed below/);
  });
  it('cancels a booking, and shows the server\'s reason when it is too late', async () => {
    let cancelled = false; detail({ 'GET /v1/me/labs': () => res(200, [lab({ bookings: cancelled ? [] : [booking()] })]), 'GET /v1/labs/slots?activityId=L1': () => res(200, [slot()]), 'POST /v1/labs/bookings/BK1/cancel': ({ n }) => (n === 1 ? res(409, { message: 'bookings can only be cancelled 24h before the slot' }) : (cancelled = true, res(201, {}))) });
    const u = userEvent.setup(); open(); await u.click(await screen.findByRole('button', { name: 'Cancel this booking' })); expect(await screen.findByRole('alert')).toHaveTextContent('24h before'); await u.click(screen.getByRole('button', { name: 'Cancel this booking' })); expect(await screen.findByText('Booking cancelled.')).toBeInTheDocument(); expect(await screen.findByText('2. Choose a session')).toBeInTheDocument();
  });
  it('shows the manual as a link when it is a URL and as text otherwise', async () => {
    detail({ 'GET /v1/me/labs': () => res(200, [lab({ manual: 'https://cdn.example/manual.pdf' })]), 'GET /v1/labs/slots?activityId=L1': () => res(200, []) }); open(); expect(await screen.findByRole('link', { name: 'Open the lab manual' })).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getByText(/No sessions are open/)).toBeInTheDocument();
  });
});

describe('Check-in and evidence', () => {
  const attended = (o: any = {}) => lab({ bookings: [booking({ status: 'ATTENDED', slot: { startsAt: iso(-30), endsAt: iso(30), location: 'W2', batchCode: 'B', cancelled: false }, ...o })] });
  it('keeps check-in closed until the window opens, with an explanation', async () => {
    detail({ 'GET /v1/me/labs': () => res(200, [lab({ bookings: [booking()] })]), 'GET /v1/labs/slots?activityId=L1': () => res(200, []) }); open(); const f = await screen.findByRole('form', { name: 'Check in' }); expect(within(f).getByRole('button', { name: 'Check in' })).toBeDisabled(); expect(within(f).getByText(/Check-in opens at/)).toBeInTheDocument();
  });
  it('accepts a pasted QR link, sends only the code, and shows the server\'s refusal for an expired code', async () => {
    let first = true; detail({ 'GET /v1/me/labs': () => res(200, [lab({ bookings: [booking({ slot: { startsAt: iso(-5), endsAt: iso(55), location: 'W2', batchCode: 'B', cancelled: false } })] })]), 'GET /v1/labs/slots?activityId=L1': () => res(200, []), 'POST /v1/labs/attendance': () => (first ? (first = false, res(403, { message: 'invalid or expired QR code' })) : res(201, { ok: true })) });
    const u = userEvent.setup(); open(); const f = await screen.findByRole('form', { name: 'Check in' }); await u.type(within(f).getByLabelText(/Check-in code/), 'https://learn.example/labs/attend?token=ABC.DEF'); await u.click(within(f).getByRole('button', { name: 'Check in' }));
    expect(await within(f).findByRole('alert')).toHaveTextContent('invalid or expired QR code'); expect(calls.find((c) => c.url === '/v1/labs/attendance')!.body).toEqual({ token: 'ABC.DEF' }); await u.click(within(f).getByRole('button', { name: 'Check in' })); expect(await screen.findByText(/Attendance recorded/)).toBeInTheDocument();
  });
  it('uploads each file, then submits the evidence once with a note', async () => {
    let sub = false; detail({ 'GET /v1/me/labs': () => res(200, [attended({ evidenceSubmitted: sub })]), 'GET /v1/labs/slots?activityId=L1': () => res(200, []), 'PUT /v1/labs/evidence/upload?name=board.jpg': () => res(200, { key: 'labs/u/1-board.jpg', name: 'board.jpg', size: 3, checksum: 'c1' }), 'PUT /v1/labs/evidence/upload?name=notes.pdf': () => res(200, { key: 'labs/u/2-notes.pdf', name: 'notes.pdf', size: 4, checksum: 'c2' }), 'POST /v1/labs/bookings/BK1/evidence': () => { sub = true; return res(201, {}); } });
    const u = userEvent.setup(); open(); const input = await screen.findByLabelText('Files'); const send = screen.getByRole('button', { name: 'Submit evidence' }); expect(send).toBeDisabled();
    await u.upload(input, [new File(['abc'], 'board.jpg', { type: 'image/jpeg' }), new File(['abcd'], 'notes.pdf', { type: 'application/pdf' })]); await u.type(screen.getByLabelText(/Note/), 'Soldered the board.'); await u.click(send);
    expect(await screen.findByText(/Evidence submitted/)).toBeInTheDocument(); const post = calls.find((c) => c.url.endsWith('/evidence'))!; expect(post.body.files.map((f: any) => f.key)).toEqual(['labs/u/1-board.jpg', 'labs/u/2-notes.pdf']); expect(post.body.note).toBe('Soldered the board.'); expect(post.headers['Idempotency-Key']).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PUT').length).toBe(2);
  });
  it('blocks files over 10 MB before uploading and shows a refusal from the scanner', async () => {
    detail({ 'GET /v1/me/labs': () => res(200, [attended()]), 'GET /v1/labs/slots?activityId=L1': () => res(200, []), 'PUT /v1/labs/evidence/upload?name=ok.png': () => res(400, { message: 'file rejected by malware scan' }) });
    const u = userEvent.setup(); open(); const input = await screen.findByLabelText('Files'); const big = new File(['x'], 'big.zip'); Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    await u.upload(input, big); expect(screen.getByText(/too large/)).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Submit evidence' })).toBeDisabled();
    await u.upload(input, new File(['x'], 'ok.png', { type: 'image/png' })); await u.click(screen.getByRole('button', { name: 'Submit evidence' })); expect(await screen.findByRole('alert')).toHaveTextContent('malware scan'); expect(calls.some((c) => c.url.endsWith('/evidence'))).toBe(false);
  });
  it('shows completion', async () => {
    detail({ 'GET /v1/me/labs': () => res(200, [lab({ completed: true, bookings: [booking({ status: 'ATTENDED', completed: true, evidenceSubmitted: true })] })]), 'GET /v1/labs/slots?activityId=L1': () => res(200, []) }); open(); expect(await screen.findByText('You have completed this lab.')).toBeInTheDocument(); expect(screen.queryByText('1. Safety notice')).toBeNull();
  });
  it('the QR landing page pre-fills the code from the link, and explains itself without one', async () => {
    route({ 'POST /v1/labs/attendance': () => res(201, {}) }); const u = userEvent.setup();
    const { unmount } = render(<MemoryRouter initialEntries={['/labs/attend?token=QRTOKEN.1']}><Routes><Route path="/labs/attend" element={<LabAttend />} /></Routes></MemoryRouter>); expect(screen.getByLabelText(/Check-in code/)).toHaveValue('QRTOKEN.1'); await u.click(screen.getByRole('button', { name: 'Check in' })); expect(await screen.findByText(/Attendance recorded/)).toBeInTheDocument(); expect(calls[0].body).toEqual({ token: 'QRTOKEN.1' }); unmount();
    render(<MemoryRouter initialEntries={['/labs/attend']}><Routes><Route path="/labs/attend" element={<LabAttend />} /></Routes></MemoryRouter>); expect(screen.getByText(/needs the code from the QR code/)).toBeInTheDocument();
  });
});
