import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../api/client';
import { AuthProvider } from '../auth';
import { PrefsProvider } from '../prefs';
import App from '../App';
import Login from '../pages/Login';
import SsoCallback from '../pages/SsoCallback';
import { Attend } from '../pages/LabDetail';
import { QrScanner } from '../components/QrScanner';
import { VideoPlayer } from '../components/VideoPlayer';
import { NetworkBanner } from '../components/NetworkBanner';
import { applyPrefs } from '../lib/privacy';
import { isReachable, setReachable } from '../lib/offline/network';
import { cameraProblem, decodeFrame } from '../lib/qr';
import type { Playback } from '../api/types';

configure({ asyncUtilTimeout: 5000 });
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
type H = (c: { body: any; url: string }) => Response | Promise<Response>;
let calls: { method: string; url: string; body: any }[] = [];
const route = (map: Record<string, H>) => vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => { const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body; calls.push({ method, url, body });
  const h = map[`${method} ${url}`]; return h ? h({ body, url }) : res(404, { message: `no route ${method} ${url}` }); }));
beforeEach(() => { calls = []; api.clear(); Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); });
afterEach(() => { vi.unstubAllGlobals(); delete (navigator as any).mediaDevices; });

// ---- QR code reading -------------------------------------------------------------------------------------------------------------------
function qrFrame(text: string, scale = 5, invert = false) {
  const q = QRCode.create(text, { errorCorrectionLevel: 'M' }); const n = q.modules.size, quiet = 4, side = (n + quiet * 2) * scale; const data = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) { const mx = Math.floor(x / scale) - quiet, my = Math.floor(y / scale) - quiet; const dark = mx >= 0 && my >= 0 && mx < n && my < n && q.modules.get(my, mx); const v = (dark ? 0 : 255) ^ (invert ? 255 : 0); const i = (y * side + x) * 4; data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255; }
  return { data, width: side, height: side };
}
describe('QR code reading', () => {
  it('decodes a coordinator code, including a link and an inverted (dark mode) screen', async () => {
    const link = 'https://learn.example.edu/labs/attend?token=eyJhbGciOi.abc-DEF_123';
    expect(await decodeFrame(qrFrame(link))).toBe(link); expect(await decodeFrame(qrFrame('ABC123', 4))).toBe('ABC123'); expect(await decodeFrame(qrFrame(link, 5, true))).toBe(link);
    expect(await decodeFrame({ data: new Uint8ClampedArray(100 * 100 * 4).fill(255), width: 100, height: 100 })).toBeNull();
  });
  it('explains camera problems in plain words', () => {
    expect(cameraProblem({ name: 'NotAllowedError' })).toBe('denied'); expect(cameraProblem({ name: 'NotFoundError' })).toBe('none'); expect(cameraProblem({ name: 'NotReadableError' })).toBe('busy'); expect(cameraProblem(new Error('x'))).toBe('other');
  });
  const camera = () => { const stop = vi.fn(); const stream = { getTracks: () => [{ stop }] }; (navigator as any).mediaDevices = { getUserMedia: vi.fn(async () => stream) };
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { get: () => 4, configurable: true }); HTMLMediaElement.prototype.play = vi.fn(async () => undefined); return { stop, gum: (navigator as any).mediaDevices.getUserMedia as ReturnType<typeof vi.fn> }; };
  it('opens the camera, reads one code, stops the camera, and reports the text once', async () => {
    const { stop, gum } = camera(); const got: string[] = []; let tries = 0;
    render(<QrScanner onResult={(t) => got.push(t)} onCancel={() => undefined} detect={async () => (++tries < 3 ? null : 'CODE-9')} />);
    await waitFor(() => expect(got).toEqual(['CODE-9'])); expect(gum).toHaveBeenCalledWith({ video: { facingMode: { ideal: 'environment' } }, audio: false }); expect(stop).toHaveBeenCalled(); await new Promise((r) => setTimeout(r, 400)); expect(got).toHaveLength(1);
  });
  it('releases the camera when cancelled, and falls back to typing when the camera is blocked or missing', async () => {
    const { stop } = camera(); const onCancel = vi.fn(); const { unmount } = render(<QrScanner onResult={() => undefined} onCancel={onCancel} detect={async () => null} />);
    await screen.findByText(/Point the camera/); await userEvent.click(screen.getByRole('button', { name: 'Stop scanning' })); expect(onCancel).toHaveBeenCalled(); unmount(); expect(stop).toHaveBeenCalled();
    (navigator as any).mediaDevices = { getUserMedia: vi.fn(async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); }) }; render(<QrScanner onResult={() => undefined} onCancel={() => undefined} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/camera is blocked/); delete (navigator as any).mediaDevices;
    render(<QrScanner onResult={() => undefined} onCancel={() => undefined} />); expect((await screen.findAllByRole('alert')).at(-1)).toHaveTextContent(/cannot use the camera/);
  });
  it('check-in: scanning fills the code and checks in at once when the window is open; typing still works', async () => {
    camera(); const slot = { startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() }; const done = vi.fn();
    (window as any).BarcodeDetector = class { async detect() { return [{ rawValue: 'https://x/labs/attend?token=T0KEN' }]; } }; // the browser's built-in reader
    route({ 'POST /v1/labs/attendance': ({ body }) => { expect(body).toEqual({ token: 'T0KEN' }); return res(201, {}); } });
    try { render(<Attend slot={slot} onDone={done} />);
      await userEvent.click(screen.getByRole('button', { name: 'Scan the QR code' })); await screen.findByText('Attendance recorded. Thank you.'); expect(done).toHaveBeenCalled(); } finally { delete (window as any).BarcodeDetector; }
  });
  it('check-in without a camera offers only the code box, and a closed window blocks scanning', async () => {
    const closed = { startsAt: new Date(Date.now() + 7_200_000).toISOString(), endsAt: new Date(Date.now() + 10_800_000).toISOString() };
    render(<Attend slot={closed} onDone={() => undefined} />); expect(screen.queryByRole('button', { name: 'Scan the QR code' })).toBeNull(); expect(screen.getByRole('button', { name: 'Check in' })).toBeDisabled();
    camera(); render(<Attend slot={closed} onDone={() => undefined} />); expect(screen.getByRole('button', { name: 'Scan the QR code' })).toBeDisabled();
  });
});

// ---- single sign-on ---------------------------------------------------------------------------------------------------------------------
const me = (roles = ['LEARNER']) => res(200, { id: 'u1', email: 'a@x.test', name: 'Asha', language: 'en', roles, mfaEnabled: false });
const tokens = { accessToken: 'AT', refreshToken: 'RT', expiresIn: 900, roles: ['LEARNER'], sessionId: 's' };
describe('single sign-on', () => {
  it('shows the button only when the server has it configured, and sends the browser to the provider', async () => {
    const assign = vi.fn(); vi.stubGlobal('location', { ...window.location, assign });
    route({ 'GET /v1/auth/sso/config': () => res(200, { enabled: true, label: 'Campus login' }), 'GET /v1/auth/sso/start': () => res(200, { authorizationUrl: 'https://idp.test/authorize?x=1' }) });
    render(<MemoryRouter><AuthProvider><Login /></AuthProvider></MemoryRouter>); await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Campus login' })); await waitFor(() => expect(assign).toHaveBeenCalledWith('https://idp.test/authorize?x=1'));
  });
  it('shows only the password form when SSO is off or the check fails', async () => {
    route({ 'GET /v1/auth/sso/config': () => res(200, { enabled: false }) }); const a = render(<MemoryRouter><AuthProvider><Login /></AuthProvider></MemoryRouter>);
    await screen.findByLabelText('Password'); expect(screen.queryByText(/Sign in with (?!the account)/)).toBeNull(); a.unmount();
    route({}); render(<MemoryRouter><AuthProvider><Login /></AuthProvider></MemoryRouter>); await screen.findByLabelText('Password');
  });
  const cb = (qs: string) => render(<MemoryRouter initialEntries={[`/sso/callback${qs}`]}><AuthProvider><Routes><Route path="/sso/callback" element={<SsoCallback />} /><Route path="/" element={<p>learner home</p>} /><Route path="/staff" element={<p>staff home</p>} /><Route path="/login" element={<p>login</p>} /></Routes></AuthProvider></MemoryRouter>);
  it('exchanges the code once and lands a learner on the home page and staff on the console', async () => {
    route({ 'GET /v1/auth/sso/callback?code=c1&state=s1': () => res(200, tokens), 'GET /v1/auth/me': () => me() }); const a = cb('?code=c1&state=s1'); await screen.findByText('learner home');
    expect(calls.filter((c) => c.url.includes('/sso/callback'))).toHaveLength(1); expect(api.signedIn).toBe(true); a.unmount(); api.clear();
    route({ 'GET /v1/auth/sso/callback?code=c2&state=s2': () => res(200, { ...tokens, roles: ['AUDITOR'] }), 'GET /v1/auth/me': () => me(['AUDITOR']) }); cb('?code=c2&state=s2'); await screen.findByText('staff home');
  });
  it('says what went wrong for a refusal, a cancelled sign-in and an incomplete link', async () => {
    route({ 'GET /v1/auth/sso/callback?code=c&state=s': () => res(403, { message: 'no active account for this identity' }) }); const a = cb('?code=c&state=s'); expect(await screen.findByRole('alert')).toHaveTextContent('no active account for this identity'); expect(screen.getByRole('link', { name: 'Back to sign in' })).toBeInTheDocument(); a.unmount();
    const b = cb('?error=access_denied'); expect(await screen.findByRole('alert')).toHaveTextContent(/cancelled or refused/); b.unmount(); cb(''); expect(await screen.findByRole('alert')).toHaveTextContent(/incomplete/);
  });
});

// ---- adaptive video, captions, language -------------------------------------------------------------------------------------------------
const hlsState = vi.hoisted(() => ({ loaded: [] as string[], handlers: {} as Record<string, (e: unknown, d: any) => void>, level: -2, destroyed: 0, supported: true }));
vi.mock('hls.js', () => ({ default: class { static isSupported = () => hlsState.supported; static Events = { MANIFEST_PARSED: 'parsed', ERROR: 'error' };
  set currentLevel(v: number) { hlsState.level = v; } get currentLevel() { return hlsState.level; } on(e: string, f: (e: unknown, d: any) => void) { hlsState.handlers[e] = f; } loadSource(u: string) { hlsState.loaded.push(u); } attachMedia() {} destroy() { hlsState.destroyed++; } } }));
const pb = (streams: Playback['streams'], extra: Partial<Playback> = {}): Playback => ({ assetId: 'a1', language: 'en', durationSec: 90, mode: 'normal', streams, interactions: [], resume: { sec: 0 }, ...extra });
const MP4 = { label: '360p', mime: 'video/mp4', url: '/v/360' }; const HLS = { label: 'hls', mime: 'application/vnd.apple.mpegurl', url: '/v1/media/hls/T' };
describe('adaptive video', () => {
  beforeEach(() => { hlsState.loaded = []; hlsState.handlers = {}; hlsState.level = -2; hlsState.destroyed = 0; hlsState.supported = true; });
  it('plays the adaptive stream with hls.js, offers a quality choice, and tidies up', async () => {
    const { container, unmount } = render(<PrefsProvider><VideoPlayer topicId="t" playback={pb([HLS, MP4])} onProgress={() => undefined} /></PrefsProvider>);
    await waitFor(() => expect(hlsState.loaded).toEqual(['/v1/media/hls/T'])); expect(container.querySelector('video')!.getAttribute('src')).toBeNull(); // the single file is not fetched as well
    expect(screen.queryByLabelText('Quality')).toBeNull(); act(() => hlsState.handlers.parsed('parsed', { levels: [{ height: 240 }, { height: 480 }, { height: 720 }] }));
    const q = await screen.findByLabelText('Quality'); await userEvent.selectOptions(q, '2'); expect(hlsState.level).toBe(2); await userEvent.selectOptions(q, '-1'); expect(hlsState.level).toBe(-1); expect(screen.getByText(/adjusts to your connection/)).toBeInTheDocument();
    unmount(); expect(hlsState.destroyed).toBeGreaterThan(0);
  });
  it('falls back to the single file when hls.js has a fatal error or the browser cannot use it', async () => {
    const a = render(<PrefsProvider><VideoPlayer topicId="t" playback={pb([HLS, MP4])} onProgress={() => undefined} /></PrefsProvider>); await waitFor(() => expect(hlsState.handlers.error).toBeTruthy());
    act(() => hlsState.handlers.error('error', { fatal: false })); expect(a.container.querySelector('video')!.getAttribute('src')).toBeNull(); act(() => hlsState.handlers.error('error', { fatal: true })); await waitFor(() => expect(a.container.querySelector('video')!.getAttribute('src')).toBe('/v/360')); a.unmount();
    hlsState.supported = false; const b = render(<PrefsProvider><VideoPlayer topicId="t" playback={pb([HLS, MP4])} onProgress={() => undefined} /></PrefsProvider>); await waitFor(() => expect(b.container.querySelector('video')!.getAttribute('src')).toBe('/v/360'));
  });
  it('hands the playlist straight to Safari, and never offers the ladder in low-bandwidth mode', async () => {
    const orig = HTMLMediaElement.prototype.canPlayType; HTMLMediaElement.prototype.canPlayType = () => 'maybe';
    try { const a = render(<PrefsProvider><VideoPlayer topicId="t" playback={pb([HLS, MP4])} onProgress={() => undefined} /></PrefsProvider>); await waitFor(() => expect(a.container.querySelector('video')!.getAttribute('src')).toBe('/v1/media/hls/T')); expect(hlsState.loaded).toEqual([]); a.unmount(); } finally { HTMLMediaElement.prototype.canPlayType = orig; }
    const low = render(<PrefsProvider><VideoPlayer topicId="t" playback={pb([{ label: 'audio', mime: 'audio/mpeg', url: '/a' }, HLS, MP4], { mode: 'low' })} onProgress={() => undefined} /></PrefsProvider>); expect(low.container.querySelector('audio')!.getAttribute('src')).toBe('/a'); expect(hlsState.loaded).toEqual([]);
  });
  it('labels the caption track in its own language and honours the captions preference', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('t'))); const cap = { label: 'captions', mime: 'text/vtt', url: '/c' };
    const a = render(<PrefsProvider><VideoPlayer topicId="t" playback={pb([MP4, cap], { language: 'hi' })} onProgress={() => undefined} /></PrefsProvider>); const track = a.container.querySelector('track')!; expect(track).toHaveAttribute('label', 'हिन्दी'); expect(track).toHaveAttribute('srclang', 'hi'); expect(track.hasAttribute('default')).toBe(true);
  });
});

describe('caption and language preferences', () => {
  it('applies caption size and background to the page', () => {
    const root = document.createElement('html'); applyPrefs({ captionSize: 'larger', captionBackground: false, language: 'hi' }, root); expect(root.dataset.captionSize).toBe('larger'); expect(root.dataset.captionBg).toBe('none'); expect(root.lang).toBe('hi');
    applyPrefs({}, root); expect(root.dataset.captionSize).toBe('normal'); expect(root.dataset.captionBg).toBe('solid');
  });
});

// ---- the app shell: language, phone menu, offline ---------------------------------------------------------------------------------------
describe('app shell', () => {
  const signedIn = () => { api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); return { 'GET /v1/auth/me': () => me(), 'GET /v1/me/preferences': () => res(200, {}), 'PUT /v1/me/preferences': ({ body }: any) => res(200, body), 'GET /v1/me/entitlements': () => res(200, []), 'GET /v1/catalogue': () => res(200, []) } as Record<string, H>; };
  const shell = (path = '/') => render(<MemoryRouter initialEntries={[path]}><AuthProvider><PrefsProvider><App /></PrefsProvider></AuthProvider></MemoryRouter>);
  it('switches the whole app to Hindi from the header, remembers it, and the phone menu opens and closes', async () => {
    let saved: any = null; route({ ...signedIn(), 'PUT /v1/me/preferences': ({ body }) => { saved = body; return res(200, body); } }); shell();
    await screen.findByRole('heading', { name: 'My courses' }); await userEvent.selectOptions(screen.getByLabelText('Language'), 'hi');
    await screen.findByRole('heading', { name: 'मेरे कोर्स' }); expect(screen.getByRole('link', { name: 'परीक्षाएँ' })).toBeInTheDocument(); expect(document.documentElement.lang).toBe('hi'); expect(saved).toEqual({ language: 'hi' }); expect(document.title).toContain('मेरे कोर्स');
    const menu = screen.getByRole('button', { name: 'मेन्यू' }); expect(menu).toHaveAttribute('aria-expanded', 'false'); await userEvent.click(menu); expect(screen.getByRole('button', { name: 'मेन्यू बंद करें' })).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('link', { name: 'परीक्षाएँ' })); expect(screen.getByRole('button', { name: 'मेन्यू' })).toHaveAttribute('aria-expanded', 'false'); // choosing a page closes the menu
  });
  it('a signed-out visitor whose browser asks for Hindi sees the sign-in page in Hindi, and can switch back', async () => {
    Object.defineProperty(navigator, 'languages', { value: ['hi-IN', 'en'], configurable: true });
    try { route({ 'GET /v1/auth/sso/config': () => res(200, { enabled: false }) }); render(<MemoryRouter><AuthProvider><PrefsProvider><Login /></PrefsProvider></AuthProvider></MemoryRouter>);
      await screen.findByRole('heading', { name: 'लर्निंग पोर्टल' }); await userEvent.click(screen.getByRole('button', { name: 'English' })); await screen.findByRole('heading', { name: 'Learning Portal' }); expect(JSON.parse(localStorage.getItem('edtech.prefs') ?? '{}').language).toBe('en');
    } finally { Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true }); }
  });
  it('with no session and no connection, sends the person to the saved lessons, not the sign-in page', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true }); route({}); shell(); await screen.findByRole('heading', { name: 'My downloads' }); expect(screen.getByText(/You are offline/)).toBeInTheDocument();
  });
  it('a server that cannot be reached counts as offline even though the device has a network, and the app finds its way back', async () => {
    sessionStorage.setItem('edtech.rt', 'RT'); vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); })); shell();
    await screen.findByRole('heading', { name: 'My downloads' }); expect(screen.getByText(/You are offline/)).toBeInTheDocument(); expect(screen.queryByLabelText('Password')).toBeNull();
    expect(isReachable()).toBe(false); act(() => setReachable(true)); await waitFor(() => expect(screen.queryByText(/You are offline/)).toBeNull());
  });
  it('the offline bar appears and disappears with the connection, and sends what was recorded while offline', async () => {
    api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); localStorage.setItem('edtech.events', JSON.stringify([{ eventId: 'e1', topicId: 't', type: 'VIDEO_HEARTBEAT', occurredAt: new Date().toISOString(), payload: { assetId: 'a', from: 0, to: 10 } }]));
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true }); route({ 'POST /v1/learning-events': ({ body }) => res(201, { results: body.events.map((e: any) => ({ eventId: e.eventId, status: 'accepted' })) }), 'GET /v1/offline/licenses?deviceId=x': () => res(200, []) });
    render(<MemoryRouter><NetworkBanner signedIn /></MemoryRouter>); expect(screen.getByRole('status')).toHaveTextContent(/You are offline/); expect(calls).toHaveLength(0);
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/learning-events')).toBe(true)); await waitFor(() => expect(screen.queryByText(/You are offline/)).toBeNull()); expect(JSON.parse(localStorage.getItem('edtech.events') ?? '[]')).toEqual([]);
    fireEvent(window, new Event('offline'));
  });
});
