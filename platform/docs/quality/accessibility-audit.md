# Accessibility audit: web client (learner portal and staff console)

Date: 2026-10-03. Target: WCAG 2.2 level AA. Scope: everything in `platform/web` (about 45 routes, learner and staff), plus the content pipeline where it decides
whether a learner can perceive the material (captions).

**This is an engineering audit by automated tools, a real-browser sweep, measurement scripts and code review. It is not a conformance claim and it does not replace
a manual audit by an accessibility specialist or testing with disabled users.** What was *not* tested is listed in section 5 and matters.

## 1. Method
| Layer | What it covered | Limits |
|---|---|---|
| axe-core 4.13 in a real browser, against the real API | Every learner route and every staff route reachable with seeded synthetic data (about 45 pages: login, courses, a topic with the video player, grades, exams, privacy, account, and all staff areas incl. detail pages), in **light, dark, and the app's high-contrast preference** (learner pages) and dark (staff). Rules: WCAG 2 A/AA, 2.1, 2.2 AA, best practice. Includes colour contrast (needs real rendering). | Only states that existed in the data: e.g. no running exam, no live video, no empty-state variants beyond those shown. axe finds roughly a third of WCAG problems. |
| axe-core after **every** unit test (`src/test/setup.ts`) | The final DOM of all 273 component tests (loading, error, empty, populated, form-error and confirmation states of every page and component). Element-level rules only: jsdom has no layout, and components render as fragments, so contrast and document-level rules are covered by the browser sweep. Fails the build on any violation: a permanent regression net. | Not contrast; not document-level rules. |
| Contrast of every design token (`src/test/a11y.test.tsx`) | Light and dark: text pairs at 4.5:1, focus ring at 3:1 on every surface, badges, buttons, status colours. | Does not see colours set outside the tokens (checked by the browser sweep). |
| Measurements in a real browser | Reflow at 320 CSS px (equivalent to 400 % zoom on a 1280 px screen); target size >= 24 px; WCAG 1.4.12 text-spacing overrides (clipping, overflow); focusable elements, positive tabindex, pointer-only controls, unnamed controls; focus-ring visibility with real Tab key presses; page title, level-one heading, landmarks and focus after a page change. | Chromium only. |
| Code review | Video player, exam runner, dialogs, forms, live regions, language and preference handling. | Judgement, not proof. |

## 2. Findings and what was done
Severity is for a person using assistive technology. "Fixed" means fixed and covered by a regression test unless stated.

| # | Finding | WCAG | Severity | Status |
|---|---|---|---|---|
| F1 | **No synchronised captions.** The player had a transcript but no captions track, and the content pipeline had no place to store captions. A deaf learner could not follow the video in time. | 1.2.2 (A) | **High** | Platform support added: `captions` (WebVTT) upload label, delivered in both playback modes with the right type, a `<track kind="captions">` (on by default, in the video's language), a note on the page when a video has none, and an advisory check in the readiness report. **Not closed:** nobody has produced captions for any content, and the check is *advisory*: making it blocking before review is the institute's decision (it would stop courses without captions from being published). |
| F2 | Page title was "Learning Portal" on every page, including after sign-out. | 2.4.2 (A) | Medium | Fixed: a title per route (`lib/titles.ts`, test fails if a route has none). |
| F3 | Nothing told a screen-reader user the page had changed, and keyboard focus stayed in the old place after navigation. | 4.1.3 (AA), 2.4.3 (A) | Medium | Fixed: `RouteAnnouncer` announces "<page>, page loaded" politely and moves focus to the content. Verified in a real browser. |
| F4 | Dialogs (the in-video question, the exam submit confirmation) did not trap focus, ignored Escape, and did not return focus when closed. | 2.1.2, 2.4.3 | Medium | Fixed: shared `Modal`: focus moves in, Tab wraps, Escape closes where closing is allowed (not for a question the learner must answer), focus returns. |
| F5 | The focus ring (amber #f59e0b) was 2.1:1 against the light page: too faint to rely on. | 1.4.11 (AA), 2.4.7 | Medium | Fixed: dark amber on light (6.6:1), bright amber on dark; staff header keeps its own light ring. Ratios are asserted in tests. |
| F6 | "Muted" badges were 4.48:1 (needs 4.5:1). Appeared on most staff pages. | 1.4.3 (AA) | Low | Fixed. |
| F7 | Content overflowed sideways at 320 px on Admissions (long references); some settings labels were clipped on Operations. | 1.4.10 (AA) | Medium | Fixed (long strings now wrap). Re-measured: no horizontal overflow on any page. |
| F8 | Checkboxes and radios were 13-20 px; staff navigation and card-title links 22 px tall. | 2.5.8 (AA) | Low | Fixed (24 px minimum). Native file inputs are browser controls and were left alone. |
| F9 | Several pages had no level-one heading while loading, on error, or when empty (Courses, Completion and others). | 1.3.1 / best practice | Low | Fixed: every state of every page keeps its heading (`Hold`). |
| F10 | Heading levels skipped (h2 to h4) in the content editor. | 1.3.1 (best practice) | Low | Fixed. |
| F11 | An empty table header cell on the exam list (actions column). | 1.3.1 (best practice) | Low | Fixed (visually hidden "Actions"). |

Checked and found **already fine**: text-spacing overrides cause no clipping; zero horizontal overflow at 320 px after F7; no positive tabindex, no pointer-only controls, no unnamed
controls; every image has an alternative (QR codes); form inputs have labels and sensible `autocomplete` (username, current/new password, one-time code; pasting allowed);
errors are shown as text, linked to a role=alert and `aria-invalid`; the exam timer, save status and announcements use live regions; the skip link works; landmarks and the
current nav item are marked; the dark theme and the high-contrast preference pass axe contrast on every page tested; reduced motion is honoured by the app's preference and
by the OS setting for the progress bar.

## 3. Result of the final sweep
Zero axe violations on every page tested, light, dark and high contrast, learner and staff, after the fixes above. 273 component tests (each followed by axe) pass.
This means *no machine-detectable failures were left in the states tested*. It does not mean the product conforms to WCAG 2.2 AA.

## 4. Re-running it
* Every build: the axe net and the token-contrast tests run with the web tests (`npm test` in `platform/web`; CI web job). `A11Y=0 npm test` skips axe for local debugging only.
* Browser sweep: start the API and `npm run dev`, sign in as each role, load `/node_modules/axe-core/axe.min.js` in the page, and run `axe.run(document)` on each route (client-side
  navigation keeps the session). Do it in light, dark (`prefers-color-scheme`) and with `document.documentElement.dataset.contrast = 'high'`. Resize the viewport to 320 px and
  check `document.documentElement.scrollWidth <= clientWidth`.

## 5. Not tested, and why it matters
* **Screen readers (NVDA, JAWS, VoiceOver, TalkBack).** No screen reader was run. Announcements, reading order and the quality of names and live regions are untested by ear.
  This is the biggest remaining gap.
* **Hindi.** There are no Hindi screens: the interface is English only (a known gap since the web client was scoped), so Devanagari rendering, line breaking, `lang` switching on content
  and Hindi captions could not be audited. The preference only changes the page language attribute.
* **Real captions and audio description on real media.** No captions file exists in the test data and the sample video is not playable, so the track was verified by
  component tests and the API's delivery, not by watching a captioned video. Audio description is a content question not addressed anywhere yet.
* **The exam under proctoring.** The exam runner was audited by axe and tests, not live with a proctoring tool or assistive technology (to confirm with the vendor).
* **Other browsers, real phones, tablets, switch access, voice control, Windows forced-colours mode, browser zoom beyond the 320 px proxy.**
* **Cognitive accessibility** (plain language, consistent help, error recovery) was reviewed informally only; the interface text is in plain English but was not user-tested.
* **People.** No disabled learner or staff member has used the product. The accessibility statement and a feedback channel do not exist yet.

## 6. What to do next, in order
1. Decide whether captions must be mandatory before review, and plan captioning of the real course content (cost and turnaround are real).
2. Have an accessibility specialist test with NVDA + Firefox/Chrome and VoiceOver + Safari/iOS on the learner journey (course, topic, quiz, assignment, exam) and the staff journeys that
   handle people (admissions, doubt desk, grading, privacy).
3. Build and audit the Hindi interface.
4. Publish an accessibility statement and a way to report barriers; test with disabled users in the pilot.
