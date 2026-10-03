# End-to-end test: two concurrent learners

Run 2026-10-03T13:08:15.188Z. Real stack: 2 API instances + worker, PostgreSQL, Redis, Docker, real ffmpeg, a stand-in push service. Two learners (one English, one Hindi) ran the whole journey **at the same time**, each on a different API instance. The test is deliberately limited to 2 users; capacity testing belongs on the deployed environment.

**89 of 89 checks passed, 0 failed.** Both learners finished in 2.1 s (journey only).


## Checks

| Learner | Check | Result |
|---|---|---|
| staff | upload master | pass |
| staff | upload 360p | pass |
| staff | upload transcript | pass |
| staff | upload captions | pass |
| staff | queue the adaptive build | pass |
| staff | real ffmpeg built the ladder | pass |
| staff | publish: FACULTY_REVIEW | pass |
| staff | publish: FACULTY_APPROVED | pass |
| staff | publish: ADMIN_APPROVAL | pass |
| staff | publish: PUBLISHED | pass |
| staff | question bank | pass |
| staff | define the exam | pass |
| staff | schedule the sitting | pass |
| staff | eligibility exception for asha | pass |
| staff | eligibility exception for ravi | pass |
| asha | sign in (own API instance) | pass |
| asha | sees only their own entitlement | pass |
| ravi | sign in (own API instance) | pass |
| asha | progress starts at 0% | pass |
| asha | cannot read the other learner's progress | pass |
| ravi | sees only their own entitlement | pass |
| asha | opens the topic | pass |
| asha | playback offers the adaptive ladder first | pass |
| asha | master playlist has 4 signed variants | pass |
| ravi | progress starts at 0% | pass |
| ravi | cannot read the other learner's progress | pass |
| ravi | opens the topic | pass |
| ravi | playback offers the adaptive ladder first | pass |
| ravi | master playlist has 4 signed variants | pass |
| asha | every rung downloads through signed URLs and decodes cleanly | pass |
| asha | watch time accepted | pass |
| asha | replayed events are duplicates, not double counted | pass |
| asha | quiz opens after the video | pass |
| asha | quiz passed | pass |
| ravi | every rung downloads through signed URLs and decodes cleanly | pass |
| asha | a retried submit with the same key replays the answer | pass |
| ravi | watch time accepted | pass |
| asha | assignment submitted and queued for evaluation | pass |
| asha | sees only their own submission | pass |
| ravi | replayed events are duplicates, not double counted | pass |
| ravi | quiz opens after the video | pass |
| asha | asks a teacher | pass |
| ravi | quiz passed | pass |
| asha | registers a device | pass |
| ravi | a retried submit with the same key replays the answer | pass |
| ravi | assignment submitted and queued for evaluation | pass |
| ravi | sees only their own submission | pass |
| asha | saves two rungs for offline and they decrypt and play | pass |
| ravi | asks a teacher | pass |
| asha | licences are valid | pass |
| ravi | registers a device | pass |
| asha | registers for push | pass |
| asha | a test push is delivered to the stand-in push service | pass |
| ravi | saves two rungs for offline and they decrypt and play | pass |
| asha | registers for the exam (eligible after the topic) | pass |
| ravi | licences are valid | pass |
| ravi | registers for push | pass |
| ravi | a test push is delivered to the stand-in push service | pass |
| ravi | registers for the exam (eligible after the topic) | pass |
| ravi | checks in | pass |
| asha | checks in | pass |
| ravi | identity confirmed by the proctoring webhook | pass |
| asha | identity confirmed by the proctoring webhook | pass |
| ravi | starts the exam (server clock) | pass |
| asha | starts the exam (server clock) | pass |
| ravi | autosave 1 | pass |
| ravi | a stale autosave is ignored, not applied | pass |
| asha | autosave 1 | pass |
| asha | a stale autosave is ignored, not applied | pass |
| ravi | autosave 2 | pass |
| ravi | the other learner cannot write to this attempt | pass |
| asha | autosave 2 | pass |
| asha | the other learner cannot write to this attempt | pass |
| ravi | submits with a receipt | pass |
| asha | submits with a receipt | pass |
| ravi | result is held for release, not shown early | pass |
| ravi | notified about the topic, the exam registration and submission | pass |
| asha | result is held for release, not shown early | pass |
| asha | notified about the topic, the exam registration and submission | pass |
| asha | push: English messages arrive, decrypted by the device | pass |
| ravi | push: Hindi messages arrive, decrypted by the device | pass |
| both | push: nobody received the other person's notification | pass |
| both | push: each notification created after subscribing is delivered exactly once | pass |
| both | exactly 2 accepted heartbeat events per learner stored | pass |
| both | two exam attempts, one per learner, both submitted | pass |
| both | the audit hash chain verifies after concurrent activity | pass |
| both | platform integrity checks are clean | pass |
| both | staff report shows both learners with the topic done | pass |
| both | no server errors in either API instance or the worker | pass |

## Slowest calls (ms)

| Call | Count | p50 | p95 | max |
|---|---|---|---|---|
| POST /v1/exams/:id/register | 2 | 229 | 229 | 229 |
| POST /v1/doubts | 2 | 222 | 222 | 222 |
| POST /v1/quiz-attempts/:id/submit | 4 | 43 | 163 | 163 |
| hls variant | 8 | 9 | 152 | 152 |
| hls segment | 24 | 10 | 72 | 150 |
| GET /v1/offline/licenses | 2 | 91 | 91 | 91 |
| POST /v1/learning-events | 4 | 27 | 84 | 84 |
| POST /v1/me/push/test | 2 | 72 | 72 | 72 |
