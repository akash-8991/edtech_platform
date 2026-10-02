# Learner web client

React 18 + TypeScript + Vite single-page app for **learners**. It talks only to the platform API (see `../docs/guides/03-user-guide.md`); the server decides all access, so the client never hides a security rule behind the UI.

**Status: learning loop, exams, and assignment grades.** Built and checked against the real API in a browser: sign in (session restore on reload), course list with progress, course/topic progress with locked topics, video playback with verified watch-time heartbeats and in-video questions, quiz, assignment (text and file), notifications, doubts (ask a teacher), AI tutor (with consent), **exams (eligibility checklist, register/cancel, consent + device check + identity wait, the exam room with server-authoritative timer, resilient autosave, resume, integrity signals, submit with receipt, result and appeal, programme completion)**, **assignment grades (list, live status while being evaluated or reviewed, score, late penalty, rubric breakdown with the quoted evidence, written feedback, who graded it, appeal with deadline), notification links**, low-bandwidth mode, responsive and keyboard-accessible layout, dark mode.

**Not built yet:** offline download/playback (licences need a native or PWA wrapper), lab booking screens,  privacy centre (export/erasure), SSO button (needs the institute's identity provider), Hindi UI strings, captions (the API serves transcripts only), push notifications, staff consoles. No independent accessibility audit has been done; the markup follows WCAG 2.1 AA practices (labels, focus, contrast, reduced motion) but has not been tested with assistive technology.

## Run it

```bash
# 1. the API must be running (platform/docs/guides/01-local-setup.md), default http://localhost:3000
cd platform/web
npm install
npm run dev                       # http://localhost:5173  (proxies /v1 to the API: no CORS setup needed)
API_TARGET=http://localhost:3300 npm run dev      # API on another port
```

Sign in with a learner account. Locally, create one: approve an application (user guide §4), then `USER_PASSWORD='Learner-Dev-Pass1' npm run user:create -- --email <email> --roles LEARNER` in `platform/api`.

## Check it

```bash
npm run typecheck && npm test      # 74 tests: API client, heartbeat tracker, outbox, quiz, assignment, login, gating, and the exam stack (clock, autosave, device check, signals, runner, list, check-in, result)
npm run build                      # production bundle in dist/ (~190 kB, 63 kB gzipped)
```

## Production hosting

`dist/` is static. Serve it from S3 + CloudFront (or any static host) on the **same site** as the API (for example `learn.institute.edu` for the app and `learn.institute.edu/v1/*` routed to the API) so no cross-origin setup is needed, or set `VITE_API_URL` at build time and list the app's origin in the API's `CORS_ORIGINS`. Serve it with a strict Content-Security-Policy (`default-src 'self'; media-src 'self' <media origin>; connect-src 'self' <api origin>`), no third-party scripts, and HSTS.

## Design notes

- **Tokens:** access token in memory only; the single-use rotating refresh token in `sessionStorage` (cleared when the tab closes). A 401 triggers one shared refresh and a retry; failure signs the user out.
- **Watch time:** `HeartbeatTracker` counts only natural playback (never seeks), cuts 20 s chunks (the server rejects >30 s), and flushes on pause, end and tab hide. Events go through a durable `localStorage` outbox so offline periods and reloads lose nothing; the server de-duplicates by event id.
- **Safe retries:** quiz and assignment submissions and new doubts carry an `Idempotency-Key`, so a retry after a dropped connection cannot double-submit.
- **Errors:** friendly messages; raw server text is never shown for 5xx.
- **Staff accounts** that sign in here are told to use the administration console (not built).

## Dependency audit

`npm audit --omit=dev` (what ships to learners) is clean (react-router upgraded to 7.x for two advisories). `npm audit` still reports issues in **development tooling** (the Vite 5 / Vitest 2 dev server and test runner); they affect only a developer's machine while the dev server runs, not the built app. Upgrade Vite/Vitest to the current major when convenient.

## Exams: how the client behaves (and what it does not claim)

- **The server owns everything that matters:** paper, answer sheet, deadline and result. The timer is computed against the server's clock (a wrong or changed laptop clock cannot extend the exam), and the exam is auto-submitted when the *server* deadline passes.
- **Autosave never drops an answer:** answers are written to a local backup the instant they change, sent debounced with an increasing sequence number, retried with backoff while offline, resent if the server was ahead, and restored after a crash or reload. `Autosaver` has 7 dedicated tests.
- **One window at a time:** resuming rotates the session token; the older window is paused and offered "Continue here instead".
- **Signals, not verdicts:** leaving the window, exiting full screen, copy and paste are reported; the server raises an incident for human review only past thresholds. The client does not block or punish.
- **Device check:** probes camera/microphone only for remote proctored exams, gives each probe a deadline (an unanswered permission prompt does not hang the page), measures bandwidth by timing a download of the app's own bundle (a coarse estimate), and cannot see how many physical screens exist beyond the browser's `isExtended` hint.
- **Limits:** camera/microphone *capture* for proctoring is the proctoring vendor's job (the page opens the vendor's window from `launchUrl`); this has only been exercised against the in-process mock provider. Full-screen is requested but a browser may refuse; the learner is reminded and it is recorded. Not tested with a screen reader or on real phones.

## Test coverage (web)

`npm run test:cov`: statements about 72%, branches about 80%. The covered areas are the logic that must not fail (API client, watch-time tracker and outbox, quiz, assignment, login, the whole exam stack). **Not covered by automated tests:** the course list/progress pages, the topic page and video player (verified by hand in a browser), notifications, doubts, tutor, programme completion. There are no end-to-end browser tests in CI; the exam journey was exercised manually against a real API on 2026-10-02.

## Assignment grades: behaviour worth knowing

- The page shows only what the API's learner view allows: while a teacher is deciding, no AI score is visible, and similarity/integrity signals are never shown. Evidence quotes appear only when the server marked them verified against the submission.
- A grade produced by the AI is labelled as automated and the appeal route is offered next to it; an appeal is once per grade, needs a written reason (20+ characters), and is decided by a different teacher. The original grade stays visible, marked "appeal under review", until then.
- Pending states (`PENDING_AI`, `MODERATION_REQUIRED`, `APPEALED`) refresh every 15 s and stop refreshing once a grade arrives.
- Verified in a browser on 2026-10-02 against the real API with a teacher-graded submission and an appeal. The AI-graded presentation (automated label, verified evidence quotes) is covered by tests only: no AI keys were available to produce one.
