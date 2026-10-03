# Learner experience: any device, Hindi, offline, captions, QR check-in, single sign-on

The learner web app (`platform/web`) works on phones, tablets, laptops and large desktop screens, in English and Hindi, and (for saved lessons and recently seen screens) without a connection.

## Devices and screens

| Screen | Behaviour |
|---|---|
| Phone (up to 759 px) | One column. The navigation folds into a **Menu** button (also in the staff console). Forms stack; buttons and fields are full width; form text is 16 px so iOS does not zoom in. Tables scroll inside their card, never the page. |
| Tablet (600–1023 px) | A wider reading column, three-up statistic tiles; staff tables use the whole width. |
| Laptop / desktop (1024 px and up) | Reading pages at 920 px, staff pages at 1240 px; 1600 px and up gets slightly larger text and wider columns. |
| Touch screens (`pointer: coarse`) | Every control is at least 44 px tall. |
| Notch, home bar, landscape phones | Safe-area insets are respected; on short landscape screens the video and dialogs use the full height. |
| Installed app | A web manifest and icons let a phone or tablet "Add to Home Screen"; it then opens full screen. |

Checked in a real browser at 320, 375, 768, 1440 px (no sideways scrolling on any learner or staff screen) and by the existing accessibility test net, which runs after every web test.

## Hindi

* The whole learner app is translated (about 570 strings; the staff console stays English by design). Language comes from, in order: the learner's saved choice, their account language, the browser's language, then English. Change it from the header selector, the sign-in page, or *Privacy and data → Accessibility and language*; the choice is saved with the account.
* Dates and numbers follow the language. Text that comes from the server (course content, feedback written by a teacher or the AI grader) is shown as authored; the AI content factory already produces Hindi course content, and the player asks for the lesson in the learner's language when it exists.
* **Adding a string:** write `t('English text')` (or `mark('…')` in a table, then `t(row.label)`), then add the English text and its Hindi to `web/src/i18n/hi.json`. The test `i18n.test.tsx` fails if a string has no Hindi, if a Hindi entry is unused, or if a `{placeholder}` is lost. **The Hindi was written by the build team and has not been reviewed by a native-speaking educator: have it reviewed before launch** (gate 6).

## Offline

What works offline, and how:

| Feature | How it works |
|---|---|
| App opens | A service worker (`public/sw.js`) caches the app itself (production builds only) and nothing from the API. |
| Saved lessons | *Topic → Save for offline* downloads the lesson (adaptive lessons offer *Small / Standard / Best*, see [Adaptive video](07-adaptive-video.md)). The server issues a **device-bound licence**: the lesson is encrypted (AES-256-GCM), its key is wrapped for this browser's RSA key (RSA-OAEP, SHA-256) and the licence expires with the entitlement and in at most `OFFLINE_DAYS` (7). The browser stores only ciphertext in IndexedDB and decrypts in memory when played; the private key is non-extractable. At most 3 devices per learner. |
| Courses, progress, topic text, notifications, labs, exams list | Read through a small per-person cache: the network always wins; saved copies are shown, with a notice, only when the server cannot be reached. A server *error* is never hidden by old data. Wiped at sign-out. |
| What you watch offline | Heartbeats and in-video answers are queued on the device and sent when you are back (the server de-duplicates by event id). |
| Exams, quizzes, assignments, lab check-in | **Online only.** The server owns the clock and the answer sheet; there is deliberately no offline exam. |

Licence rules the app enforces: while online it asks the server which licences are still valid and deletes saved lessons whose access ended (revoked, entitlement paused/ended, expired); offline it checks the expiry and refuses a clock set back. The device can be offline in two ways and both are handled: no network, or a network but an unreachable server (detected by failed requests and probed every 8 s).

Push notifications (new): *Privacy and data → Push notifications*, see [Mobile app and push](09-mobile-and-push.md). The staff console is English only.

Limits to know: saved lessons play without signing in on that device until they expire (a shared device is therefore as private as its browser profile; *Remove all downloads* is on the downloads page); clearing site data deletes the downloads and the device key; storage is the browser's quota (checked before a download). The service worker could not be exercised in the in-app browser used during the build (it refuses registration); its logic is unit-tested and it needs one pass in desktop Chrome and mobile Safari before launch.

## Captions

Captions are WebVTT tracks that play in the learner's caption language, are on by default, and can be styled: **size** (normal, large, larger), **dark background** on/off, language, and on/off. A lesson without captions says so and offers the transcript. Saved lessons keep their captions and transcript. The video engine now produces WebVTT and a transcript for every language from the reviewed narration (`video_engine/captions.py`); `publish.py` uploads them.

## QR check-in (labs)

*Lab → Check in → Scan the QR code* opens the camera, reads the coordinator's rotating code (built-in `BarcodeDetector` where the browser has it, otherwise the bundled `jsQR` on a down-scaled frame), stops the camera and checks in at once if the window is open. The camera is released when a code is read, on cancel and on leaving the page; nothing is recorded or uploaded. If the camera is blocked, missing or busy, the learner is told why and can type the code or follow the link from a phone camera. Camera access needs https (or localhost).

## Single sign-on

`GET /v1/auth/sso/config` tells the sign-in page whether to show **Sign in with <OIDC_LABEL>**; the button goes to the provider and back to the **web app's** `/sso/callback` page, which hands the one-time code to the API (`GET /v1/auth/sso/callback`) and signs the person in. Configure the provider with the redirect URI **`https://<web-host>/sso/callback`** (set `OIDC_REDIRECT_URI` to the same value). Accounts are not auto-created: the person must already exist (see `docs/guides/04-configuration-reference.md`). Privileged roles still need multi-factor at the provider (`OIDC_MFA_AMR`). **Not tested against a real identity provider.**
