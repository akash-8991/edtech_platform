# Learner web client and staff console

React 18 + TypeScript + Vite single-page app: the **learner portal** (`/`) and a first **staff console** (`/staff`) in one build; sign-in sends each person to the right one by role. It talks only to the platform API (see `../docs/guides/03-user-guide.md`); the server decides all access, so the client never hides a security rule behind the UI.

**Status: learning loop, exams, assignment grades, labs, and the privacy centre.** Built and checked against the real API in a browser: sign in (session restore on reload), course list with progress, course/topic progress with locked topics, video playback with verified watch-time heartbeats and in-video questions, quiz, assignment (text and file), notifications, doubts (ask a teacher), AI tutor (with consent), **exams (eligibility checklist, register/cancel, consent + device check + identity wait, the exam room with server-authoritative timer, resilient autosave, resume, integrity signals, submit with receipt, result and appeal, programme completion)**, **assignment grades (list, live status while being evaluated or reviewed, score, late penalty, rubric breakdown with the quoted evidence, written feedback, who graded it, appeal with deadline), notification links**, **privacy centre (versioned consents with withdrawal, data download / correction / erasure requests with password confirmation and status tracking, authenticated download of the export, accessibility and language preferences applied across the app, active sessions with sign-out, password change)**, **lab booking (status per lab with what is blocking you, lab manual, safety-notice acceptance, session list with seats left and booking, cancel, QR check-in by pasted code or by opening the QR link, evidence upload, completion)**, low-bandwidth mode, responsive and keyboard-accessible layout, dark mode.

**Not built yet:** offline download/playback (licences need a native or PWA wrapper),  SSO button (needs the institute's identity provider), Hindi UI strings, captions (the API serves transcripts only), push notifications, staff consoles. No independent accessibility audit has been done; the markup follows WCAG 2.1 AA practices (labels, focus, contrast, reduced motion) but has not been tested with assistive technology.

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
npm run typecheck && npm test      # 131 tests: API client, heartbeat tracker, outbox, quiz, assignment, login, gating, and the exam stack (clock, autosave, device check, signals, runner, list, check-in, result)
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

## Privacy centre: behaviour worth knowing

- **Consent** is recorded against the *current* notice version; a choice made under an older notice shows as off until the learner confirms it again. The consent wording on screen is placeholder text: the institute's legal text and notice versions must replace it before launch.
- **Data requests:** export and erasure re-confirm the password (the server also accepts a fresh SSO sign-in, which this client does not use yet); only one open request of each kind is allowed; an export downloads through an authenticated request (a plain link cannot carry the token) and expires on the server's schedule. Erasure needs the password *and* typing ERASE, states what is kept (a pseudonymised academic record) and what blocks it (an active course or legal hold), and is approved by staff.
- **Preferences** (contrast, reduced motion, larger targets, text size and spacing, playback speed, transcripts by default, low bandwidth) apply immediately, are kept locally for the first paint, saved to the server, and rolled back if saving fails. Text size scales the whole interface (rem-based). Not implemented: captions (no caption files exist yet), audio description, and translated screens for Hindi.
- Verified in a browser on 2026-10-02 against the real API: consent on, wrong then right password, export request processed by the worker and ready to download (the download itself checked at the API level; the browser save dialog is not observable in the test pane), preferences persisting across a reload, sessions list. Erasure was deliberately **not** submitted for the demo learner.

## Labs: behaviour worth knowing

- **Eligibility is the server's:** booking needs the prerequisite topics complete and the *current* safety notice accepted (a changed notice must be accepted again). The page lists what is missing in plain words; the server still re-checks everything, and a refusal shows its reason (full, too late to cancel, not eligible).
- **Check-in** uses a code the lab coordinator displays, which rotates every 90 seconds. A phone camera scan opens `/labs/attend?token=...` with the code filled in; the code (or the whole link) can also be pasted on the lab page. The page only explains the window (opens 15 minutes before the session, closes at its end); the server decides. Scanning with the app's own camera is not built.
- **Evidence** (up to 5 files, 10 MB each, malware-scanned) is uploaded before the submission is sent, so a failed upload sends nothing; a lab completes when attendance is recorded and, if required, evidence is accepted.
- This needed one **small API addition**: `GET /v1/me/labs` now includes each booking's slot (time, place, batch, cancelled), because a booking whose session has already started was otherwise impossible to show.
- Verified in a browser on 2026-10-02 against the real API: accept notice, book, check in via the QR link, upload evidence, lab completed, programme completion and notifications updated. Using an uploaded real photo, a full session, a refused cancellation and a cancelled session were covered by tests only. The lab and slots were created by SQL / the coordinator API as fixtures (lab authoring on a draft version is covered by the API's own tests).

## Staff console (`/staff`): what exists and what does not

**Built:**
- **Staff sign-in with two-step verification:** password, then an authenticator-app code or a one-time backup code; first sign-in walks through setting up the authenticator (QR code and manual key) and shows the backup codes once. Production enforces this for every staff role; locally set `MFA_ENFORCE=1` to rehearse it.
- **Role-aware shell:** each person sees only the areas their role allows (the server enforces every call regardless). A staff-only account never sees the learner portal; a learner is sent away from the console.
- **Admissions** (academic and platform admins decide; support staff read): queue by status with paging, approve / return / reject (reason required for the last two, the server's refusal shown as is), CSV import with created / duplicate / invalid reporting.
- **Lab desk** (lab coordinators and academic admins): pick a lab, plan sessions with local validation, see ongoing, past and cancelled sessions, run a session: a **check-in code shown as a QR that refreshes before it expires**, a live roster, mark present or no-show, complete a booking by exception (reason required, audited), cancel a session (warns that learners are notified; reason required).
- **Operations** (platform admins, auditors and others by role): live exam numbers, the full integrity check (clear failure presentation and what to do), and platform settings editable by type with live validation, emergency controls (AI kill switch, exam change freeze) first and behind a confirmation.

**Not built yet (use the API, see the user guide):** content authoring and review, grading moderation, exam operations beyond the dashboard (incidents, results release, appeals), the doubt desk for teachers, privacy-request handling, user management (users are still created by `npm run user:create` or by approving an application), reports, entitlement management.

One **small API addition** supports this: `GET /v1/labs/slots?scope=all` (coordinators only) also returns ongoing, past (30 days) and cancelled sessions; without it a session already in progress could not be listed. Covered by an API test.

Verified in a browser on 2026-10-02 against the real API with `MFA_ENFORCE=1`: a lab coordinator and a platform admin each completed first-time authenticator enrolment (the code computed from the shown key), the lab desk showed the live roster and a refreshing QR, the integrity check passed on the real database, the AI kill switch was changed through its confirmation and changed back, and approving an application for a non-existent programme showed the server's refusal. Approvals, rejections, imports, attendance changes and cancellations are covered by tests only. No screen-reader testing.
