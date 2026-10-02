# Learner web client

React 18 + TypeScript + Vite single-page app for **learners**. It talks only to the platform API (see `../docs/guides/03-user-guide.md`); the server decides all access, so the client never hides a security rule behind the UI.

**Status: first slice.** Built and checked against the real API in a browser: sign in (session restore on reload), course list with progress, course/topic progress with locked topics, video playback with verified watch-time heartbeats and in-video questions, quiz, assignment (text and file), notifications, doubts (ask a teacher), AI tutor (with consent), low-bandwidth mode, responsive and keyboard-accessible layout, dark mode.

**Not built yet:** offline download/playback (licences need a native or PWA wrapper), exams and lab booking screens, grade and feedback views and appeals, privacy centre (export/erasure), SSO button (needs the institute's identity provider), Hindi UI strings, captions (the API serves transcripts only), push notifications, staff consoles. No independent accessibility audit has been done; the markup follows WCAG 2.1 AA practices (labels, focus, contrast, reduced motion) but has not been tested with assistive technology.

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
npm run typecheck && npm test      # 29 unit/component tests (API client, heartbeat tracker, outbox, quiz, assignment, login, gating)
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
