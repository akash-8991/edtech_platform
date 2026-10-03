# Accessibility (target: WCAG 2.2 AA, plus Hindi/English and low-bandwidth needs)

**Status: cannot be certified yet.** The web client (learner portal and staff console) was audited on 2026-10-03 by automated tools, a real-browser sweep and
code review: see [quality/accessibility-audit.md](quality/accessibility-audit.md) for findings, fixes and, importantly, what was **not** tested (screen readers, Hindi,
real captioned video, people). The native mobile apps do not exist. This document records what the *API and content pipeline* enforce and what every client must do and be tested for.

## Enforced / provided by the platform
| Need | Mechanism |
|---|---|
| Captions/transcripts | Transcript required for every mandatory video before a version can enter review (production default; `ACCESSIBILITY_ENFORCE`); **captions (WebVTT, label `captions`) are delivered and shown on the video in the learner's caption language, with size and background choices; the video engine now generates them from the reviewed narration; a missing captions file is an advisory finding, not yet blocking (WCAG 1.2.2 needs it: institute decision)**; report at `GET /authoring/versions/:id/accessibility` |
| Screen-reader access to interactions | Every interaction must have a text prompt (blocking check); quality gate requires audio descriptions for visual-only scenes |
| Audio-only and low-bandwidth | `audio` and `360p` renditions (advisory checks); low-bandwidth playback mode returns audio + transcript first |
| Hindi/English parity | Separate reviewed tracks; Hindi fidelity gate; Hindi quiz/assignment text; glossary lock |
| Personalisation | `GET/PUT /me/preferences`: captions, caption language, playback speed (0.5-2x), font scale, high contrast, reduced motion, text spacing, large targets, audio description, transcript by default, low bandwidth |
| Exam accommodations | extra time (up to +100 %), breaks, assistive-technology flag, per learner, audited |
| No time pressure on reading content | gating is by completion, not by clock; deadlines are policy-driven with documented extensions |

## Client acceptance checklist (to be executed on real builds)
Keyboard-only operation of every flow including the player and exam; visible focus; no keyboard traps; semantic headings/landmarks/labels;
contrast 4.5:1 text and 3:1 UI; reflow at 320 px and 400 % zoom; text spacing overrides; touch targets >= 24x24 CSS px; captions with
speaker/sound cues, adjustable size; transcript synchronised and searchable; no content flashing; reduced-motion respected; screen-reader
testing with NVDA/JAWS, VoiceOver, TalkBack on web and native apps; Devanagari rendering and line-breaking; timers announced politely and
extendable; error messages programmatically associated; drag-and-drop alternatives; exam page compatible with assistive technology under
the proctoring tool (confirm with the vendor); alternative formats on request.

## Process
Automated checks in CI (axe) per page; manual audit by an accessibility specialist; testing with disabled learners in the pilot; publish an
accessibility statement and a feedback channel; track defects with severity SLAs.
