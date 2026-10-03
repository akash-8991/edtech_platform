# User guide: how to use the platform

This guide walks through every role's day-to-day work using the platform's HTTP API with `curl`. **There is no production web or mobile client yet** (a first slice of the learner web client exists in `platform/web`; see its README for what it covers); everything here is also what a client does under the hood.

How to read the status markers:

- **[verified]** the command is executed by `npm run walkthrough` (31 checks against a real server and database). If the walkthrough passes, these commands work.
- **[tested]** the behaviour is covered by the automated test suite (`platform/api/test/*.spec.ts`), but the exact `curl` below has not been run by the walkthrough. Payload shapes come from those tests.
- **[needs external service]** needs an AI key, a proctoring vendor, an identity provider, Docker or similar. These integrations have **never been run against the real service**, only against test doubles; expect to adjust.

Prerequisites for every command: the API is running ([local setup](01-local-setup.md)), `curl` and `jq` are installed, and these shell variables are set:

```bash
export BASE=http://localhost:3000        # your API address
export PASS='Dev-Only-Pass1'              # the password of the seeded synthetic users (local development only)
```

---

## 1. The big picture

### 1.1 Roles

| Role | Who | Can do |
|---|---|---|
| `LEARNER` | enrolled student | learn, take quizzes/assignments/exams, ask the tutor, raise doubts, book labs, manage own data and sessions |
| `CONTENT_AUTHOR` | course author | create programmes, versions, topics, assets, quizzes, assignments; submit for review; start AI generation jobs |
| `FACULTY_REVIEWER` | academic reviewer | review and approve content, resolve AI quality flags, moderate AI-graded work |
| `APPROVER_PUBLISHER` | final approver | the only role that can publish a course version |
| `ACADEMIC_ADMIN` | academic operations | import/decide applications, manage entitlements, overrides, doubt-centre staffing, reports |
| `ASSESSMENT_ADMIN` | assessment owner | grading oversight, overrides, benchmarks |
| `EXAM_ADMIN` | exam operations | question bank, exam definitions, sessions, incidents, results |
| `DOUBT_TEACHER` | doubt-centre teacher | answer learner doubts, appointments |
| `LAB_COORDINATOR` | lab staff | lab slots, rosters, attendance |
| `SUPPORT_OPERATOR` | support | read-only help, revoke sessions, file privacy requests on behalf of a learner |
| `PLATFORM_ADMIN` | technical admin | runtime configuration, kill switch, integrity, privacy processing, MFA reset |
| `SUPER_ADMIN` | break-glass owner | everything above that is not segregated |
| `AUDITOR` | read-only auditor | audit trail, reports, integrity verification |

The precise role list for every endpoint is in the generated [API reference](api-reference.md).

### 1.2 The lifecycle in one picture

```
 author builds course ─► faculty review ─► approval ─► PUBLISHED (frozen, versioned)
                                                          │
 admissions system ─► application ─► admin approves ──────┤
                                                          ▼
                              learner account + entitlement (dates, pauses, exceptions)
                                                          │
          learn topic 1 ─► watch video ─► answer in-video questions ─► quiz ─► assignment ─► topic 2 unlocks ...
                                                          │
                       tutor / doubts / labs ─► final exam (proctored) ─► completion
```

Every decision (publish, approve, override, revoke, grade change, access) is written to an **append-only, hash-chained audit trail** that nobody, including administrators, can edit or delete.

### 1.3 Conventions

- All endpoints are under `/v1` (except `/health`, `/health/ready`, `/metrics`).
- Send JSON with `Content-Type: application/json`. Bodies with unknown fields are rejected on the stricter endpoints (400 `validation_failed`).
- Authenticated calls need `Authorization: Bearer <accessToken>`. Access tokens last **15 minutes**; use the refresh token to get a new pair.
- Errors: `401` not signed in / token expired; `403` signed in but not allowed (wrong role, locked topic, no entitlement); `404` not found *or* not yours; `409` conflict with current state (e.g. quiz before video is watched, already decided); `422` rejected by a rule (e.g. reused idempotency key); `429` rate limited (see `Retry-After`).
- **Safe retries.** For any `POST`/`PUT`/`PATCH`/`DELETE` add an `Idempotency-Key: <8-128 chars>` header. If the network drops and you resend the same request with the same key, the original answer is replayed (header `Idempotent-Replay: true`) and nothing happens twice. A different request with the same key gets 422.
- **Lists** are paginated with `?limit=` (default 50, max 200) and `?cursor=`; the next cursor is in the `X-Next-Cursor` response header (absent on the last page).
- **Tracing.** Every response carries `X-Correlation-Id` and `X-Trace-Id`; quote them in any support request.

A tiny helper used in the rest of this guide:

```bash
login() { curl -sS -X POST $BASE/v1/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"${2:-$PASS}\"}" | jq -r .accessToken; }
```

---

## 2. Signing in

### 2.1 Password sign-in **[verified]**

```bash
curl -sS -X POST $BASE/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@synthetic.test","password":"Dev-Only-Pass1"}' | jq
```

A successful response contains `accessToken`, `refreshToken`, `expiresIn` (seconds) and `roles`. Keep the access token in a variable:

```bash
ADMIN=$(login admin@synthetic.test)
curl -sS $BASE/v1/auth/me -H "Authorization: Bearer $ADMIN" | jq     # who am I?
```

Wrong passwords return a generic `401` (the response never says whether the email exists). After **5 failures** the account is locked for **15 minutes**; sign-in is also rate-limited per IP and per account.

### 2.2 Refreshing a session **[tested]**

```bash
REFRESH=$(curl -sS -X POST $BASE/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@synthetic.test","password":"Dev-Only-Pass1"}' | jq -r .refreshToken)
curl -sS -X POST $BASE/v1/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$REFRESH\"}" | jq
```

Refresh tokens are **single use**: each refresh returns a new pair and the old token dies. If an old token is presented again, the platform assumes theft and **ends the whole session**.

### 2.3 Multi-factor authentication (staff) **[tested]**

In production every non-learner role must use an authenticator app (TOTP). In local development MFA is off unless you set `MFA_ENFORCE=1`. With MFA enforced, a staff member's first sign-in returns `mfaEnrollmentRequired: true` and an `enrollmentToken`:

```bash
# 1. start enrolment (works with the enrollment token from login, or with a normal access token)
curl -sS -X POST $BASE/v1/auth/mfa/enroll/start -H "Authorization: Bearer $ENROLL_TOKEN" | jq   # {secret, otpauthUri}
#    Add the secret / otpauthUri to an authenticator app (Google Authenticator, Authy, 1Password ...)
# 2. confirm with the 6-digit code; the response shows 10 backup codes EXACTLY ONCE. Store them safely.
curl -sS -X POST $BASE/v1/auth/mfa/enroll/confirm -H "Authorization: Bearer $ENROLL_TOKEN" \
  -H 'Content-Type: application/json' -d '{"code":"123456"}' | jq
# 3. later sign-ins return {mfaRequired:true, mfaToken}; finish with a current code (or a backup code)
curl -sS -X POST $BASE/v1/auth/mfa/verify -H 'Content-Type: application/json' \
  -d "{\"mfaToken\":\"$MFA_TOKEN\",\"code\":\"123456\"}" | jq
```

If a staff member loses their device, a `PLATFORM_ADMIN` resets their MFA (audited): `POST /v1/admin/users/<userId>/mfa-reset` with `{"reason":"lost phone, identity verified by phone call"}`.

### 2.4 Password, sessions and devices **[tested]**

```bash
# change password (12+ characters, not common, must not contain your email name); signs out all OTHER devices
curl -sS -X POST $BASE/v1/auth/password -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"current":"Old-Pass-123456","next":"New-Strong-Pass-7"}' | jq
curl -sS $BASE/v1/me/sessions -H "Authorization: Bearer $TOKEN" | jq        # my active sessions
curl -sS -X DELETE $BASE/v1/me/sessions/<sessionId> -H "Authorization: Bearer $TOKEN"   # sign one out
curl -sS -X POST $BASE/v1/auth/logout -H "Authorization: Bearer $TOKEN"     # sign out this session
```

Support/admin can end every session of a user: `POST /v1/admin/users/<userId>/revoke-sessions` `{"reason":"..."}`.

### 2.5 People: creating accounts, roles, suspension **[tested]**

In the staff console this is the **People** area. The same calls over the API (super admin or platform admin to change; auditors and support can read):

```bash
curl -sS "$BASE/v1/admin/users?q=ada&role=CONTENT_AUTHOR&status=ACTIVE&limit=50" -H "Authorization: Bearer $ADMIN" | jq     # next page: ?cursor=<X-Next-Cursor header>
curl -sS $BASE/v1/admin/users/<userId> -H "Authorization: Bearer $ADMIN" | jq                    # details + last 25 audited changes
# new account: returns a one-time temporaryPassword ONCE (omit it with "ssoOnly":true). Give it over a safe channel; they change it from their account page.
curl -sS -X POST $BASE/v1/admin/users -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"email":"ada@institute.edu","name":"Ada Author","roles":["CONTENT_AUTHOR"]}' | jq
# roles (global ones): a reason is required; signs them out everywhere so it takes effect at once
curl -sS -X POST $BASE/v1/admin/users/<userId>/roles -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"add":["DOUBT_TEACHER"],"remove":[],"reason":"joins the doubt desk"}'
curl -sS -X POST $BASE/v1/admin/users/<userId>/status -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"status":"SUSPENDED","reason":"left the institute"}'   # or ACTIVE
curl -sS -X POST $BASE/v1/admin/users/<userId>/unlock -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{}'
curl -sS -X POST $BASE/v1/admin/users/<userId>/reset-password -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"reason":"cannot get in"}' | jq   # one-time password, shown once
```

Rules (decision D-086, to be confirmed by the institute): only a super admin creates, grants or manages anyone holding SUPER_ADMIN or PLATFORM_ADMIN; nobody changes their own roles or status; one active super admin always remains; a person keeps at least one role. The first super admin is still created with the setup script (section 2.1).

### 2.5 Single sign-on (OIDC) **[needs external service]**

Learners normally sign in through the institute's identity provider. Set the `OIDC_*` variables ([configuration reference](04-configuration-reference.md#single-sign-on)), then a client sends the browser to the URL returned by `GET /v1/auth/sso/start`; the provider redirects back to `/v1/auth/sso/callback`. Accounts are **never auto-created** by SSO; an administrator must provision the user first. For staff, the identity provider must assert multi-factor authentication (`amr` claim) or sign-in is refused.

### 2.6 Creating users (administrators) **[verified]**

There is no user-management API yet. Users are provisioned by (a) approving an admission application (creates the learner), and (b) the supported command-line tool for staff and for the first administrator:

```bash
cd platform/api
USER_PASSWORD='A-Long-Passphrase-42' npm run user:create -- \
  --email you@institute.edu --name "Your Name" --roles SUPER_ADMIN,PLATFORM_ADMIN
```

It is idempotent (re-running adds roles or resets the password) and writes an audit event. Pass the password through the `USER_PASSWORD` variable rather than `--password` so it stays out of shell history.

---

## 3. Authors: building and publishing a course **[verified]**

This is the complete path used by the walkthrough. Roles: author (`author@synthetic.test`), faculty (`faculty@synthetic.test`), approver (`approver@synthetic.test`). Four *different* people must act (maker-checker; set `SEGREGATION_OF_DUTIES=false` only for single-person demos).

```bash
AUTHOR=$(login author@synthetic.test); FACULTY=$(login faculty@synthetic.test); APPROVER=$(login approver@synthetic.test)
CODE=DEMO-1

# 1. a programme (a stable identity, e.g. "AI & ML Foundations")
curl -sS -X POST $BASE/v1/authoring/programmes -H "Authorization: Bearer $AUTHOR" -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"title\":\"Demo programme\",\"discipline\":\"AI\"}" | jq

# 2. a version with its modules and topics (versions are what gets reviewed, published and frozen)
VERSION=$(curl -sS -X POST $BASE/v1/authoring/programmes/$CODE/versions -H "Authorization: Bearer $AUTHOR" -H 'Content-Type: application/json' \
  -d '{"hours":1,"languages":["en"],"modules":[{"title":"Module 1","topics":[{"title":"Topic 1","hours":1}]}]}')
VERSION_ID=$(jq -r .id <<<"$VERSION"); TOPIC_ID=$(jq -r '.modules[0].topics[0].id' <<<"$VERSION")

# 3. a video asset for the topic, with an in-video question at 30 s that the learner must answer
ASSET_ID=$(curl -sS -X POST $BASE/v1/authoring/topics/$TOPIC_ID/assets -H "Authorization: Bearer $AUTHOR" -H 'Content-Type: application/json' \
  -d '{"language":"en","durationSec":100,"provenance":{"model":"manual","source":"docs"},
       "interactions":[{"id":"ix1","atSec":30,"kind":"pause_quiz","required":true,"prompt":"2+2?","correct":1}]}' | jq -r .id)

# 4. upload the files (raw bytes; the label says what each file is). Required labels: master, 360p, audio, transcript
for label in master 360p audio transcript; do
  curl -sS -X PUT $BASE/v1/authoring/assets/$ASSET_ID/files/$label -H "Authorization: Bearer $AUTHOR" \
    -H 'Content-Type: application/octet-stream' --data-binary @./video.mp4 >/dev/null     # use real files; any bytes work locally
done

# 5. a quiz (single-choice and numeric questions) and an assignment
curl -sS -X PUT $BASE/v1/authoring/topics/$TOPIC_ID/quiz -H "Authorization: Bearer $AUTHOR" -H 'Content-Type: application/json' -d '{
  "passPercent":60,"maxAttempts":3,"questions":[
   {"type":"MCQ_SINGLE","text":"Pick option b","options":["a","b"],"answer":1,"points":1,"rationale":"because b"},
   {"type":"NUMERIC","text":"2+2","answer":4,"tolerance":0.1,"points":1}]}' | jq
curl -sS -X PUT $BASE/v1/authoring/topics/$TOPIC_ID/assignment -H "Authorization: Bearer $AUTHOR" -H 'Content-Type: application/json' \
  -d '{"instructions":"Write two sentences about what you learned.","maxSubmissions":2}' | jq

# 6. move through the review states; each call is a different role
t() { curl -sS -X POST $BASE/v1/authoring/versions/$VERSION_ID/transition -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d "{\"to\":\"$2\"}"; }
t $AUTHOR   FACULTY_REVIEW      # author submits (fails with a list of issues if something is missing)
t $FACULTY  FACULTY_APPROVED
t $FACULTY  ADMIN_APPROVAL
t $APPROVER PUBLISHED           # only APPROVER_PUBLISHER can publish
curl -sS $BASE/v1/catalogue -H "Authorization: Bearer $AUTHOR" | jq     # now listed
```

What the platform enforces for you:

- A **mandatory topic** cannot enter review without an English video, quiz and assignment. The error lists exactly what is missing.
- With accessibility enforcement on (the production default), **every mandatory video needs a transcript and text for every in-video interaction**.
- Once under review, a version is **frozen**; once published, it is **immutable**. Changes happen in a new version (`POST /v1/authoring/versions/<id>/clone`), and `GET /v1/authoring/versions/<id>/diff?against=<otherId>` shows what changed.
- Reviewers can leave comments (`/v1/authoring/versions/<id>/comments`). Every transition is audited with who, when and why.

### 3.1 Generating content with AI **[needs external service]**

Authors can ask the AI content factory to draft a curriculum or a topic (script, scenes, quiz candidates in English and Hindi). It needs `ANTHROPIC_API_KEY` and/or `OPENROUTER_API_KEY` ([configuration](04-configuration-reference.md#ai)); check connectivity first with `npm run ai:smoke` in `platform/api`.

```bash
# curriculum for a programme (async: returns 202 and a job id)
JOB=$(curl -sS -X POST $BASE/v1/ai/curriculum-jobs -H "Authorization: Bearer $AUTHOR" -H 'Content-Type: application/json' -d '{
  "programme":{"code":"AI-12","title":"AI Foundations"},"title":"AI Foundations","discipline":"AI/ML","audience":"graduates",
  "durationType":"M12","hours":12,"outcomes":["Understand supervised learning"],"languages":["en","hi"]}' | jq -r .id)
curl -sS $BASE/v1/ai/jobs/$JOB -H "Authorization: Bearer $AUTHOR" | jq '{status,error}'     # poll until SUCCEEDED

# a topic script + scenes
curl -sS -X POST $BASE/v1/ai/topic-jobs -H "Authorization: Bearer $AUTHOR" -H 'Content-Type: application/json' \
  -d "{\"topicId\":\"$TOPIC_ID\",\"languages\":[\"en\",\"hi\"],\"references\":[{\"id\":\"R1\",\"text\":\"...source passage...\"}]}" | jq
```

Safeguards you do not have to build: output is checked against the learning outcomes, glossary and prohibited terms; unsupported or unsafe content produces **quality flags** (`GET /v1/ai/quality?versionId=<id>`) that a `FACULTY_REVIEWER` must resolve before the version can progress; every call is recorded with its prompt version, cost and provenance; there is a **daily budget** and a **kill switch** ([operations](#9-operations)). **AI-generated learner content is never published without human approval.**

The generated script manifest feeds the [video engine](05-video-engine.md) to produce the actual video.

---

## 4. Admissions: from application to enrolled learner

### 4.1 How applications arrive

Either the admissions system posts them with a signed server-to-server call, or staff import them.

**Signed webhook** **[verified]** (the signature is HMAC-SHA256 over `<timestamp-ms>.<raw body>` with the shared `ADMISSIONS_HMAC_SECRET`; requests older than 5 minutes are refused):

```bash
export ADMISSIONS_HMAC_SECRET='the-shared-secret'
BODY='{"applications":[{"externalRef":"ADM-001","email":"asha@example.org","name":"Asha Rao","programmeCode":"DEMO-1","duration":"M12","cohort":"2026-A"}]}'
TS=$(($(date +%s)*1000))
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$ADMISSIONS_HMAC_SECRET" -hex | sed 's/^.* //')
curl -sS -X POST $BASE/v1/admissions/applications -H "x-timestamp: $TS" -H "x-signature: $SIG" -H 'Content-Type: application/json' -d "$BODY" | jq
```

**Staff import** **[verified]** (`ACADEMIC_ADMIN`; JSON or CSV with headers `externalRef,email,name,programmeCode,duration,cohort`; up to 1,000 rows per call):

```bash
ADMIN=$(login admin@synthetic.test)
curl -sS -X POST $BASE/v1/applications/import -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"applications":[{"externalRef":"ADM-002","email":"ravi@example.org","name":"Ravi K","programmeCode":"DEMO-1","duration":"M12","cohort":"2026-A"}]}' | jq
# CSV form:  -d "$(jq -nc --rawfile c applications.csv '{csv:$c}')"
```

The response reports each row as `created`, `duplicate` (same `externalRef`; safe to resend) or `invalid` (with reasons). Duration is `M12` or `M18`; `language` may be `en` or `hi`.

### 4.2 Deciding **[verified]**

```bash
curl -sS "$BASE/v1/applications?status=RECEIVED&limit=50" -H "Authorization: Bearer $ADMIN" | jq     # the queue
curl -sS -X POST $BASE/v1/applications/<applicationId>/decision -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"decision":"APPROVE"}' | jq        # also: REJECT / RETURN (reason required), optional "startAt":"2026-11-01T00:00:00Z"
```

Approval creates the learner account and an **entitlement** (learner × published course version × start/end dates). It requires a **published** version for the programme; a learner can hold only one entitlement per version (the second is refused with 409); an application that is already approved or rejected cannot be decided again (a *returned* one can).

### 4.3 Managing an entitlement **[tested]**

```bash
E=<entitlementId>
curl -sS $BASE/v1/entitlements/$E/access -H "Authorization: Bearer $ADMIN" | jq        # server-side access decision and reasons
curl -sS -X POST $BASE/v1/entitlements/$E/pause  -H "Authorization: Bearer $LEARNER" -H 'Content-Type: application/json' -d '{"reason":"medical"}'   # limited count and days by policy
curl -sS -X POST $BASE/v1/entitlements/$E/resume -H "Authorization: Bearer $LEARNER"
curl -sS -X POST $BASE/v1/entitlements/$E/exceptions -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"extendDays":14,"reason":"approved hardship request"}'
curl -sS -X POST $BASE/v1/entitlements/$E/revoke -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"reason":"policy breach, case #123"}'
```

Pause limits (`POLICY_MAX_PAUSES`, `POLICY_MAX_PAUSED_DAYS`) are configuration. Progression overrides for a single learner (unlock a topic, extra quiz attempts, deadline extension) are `POST /v1/entitlements/<id>/progression-overrides` with `{"topicId","type":"UNLOCK_TOPIC|EXTRA_QUIZ_ATTEMPTS|DEADLINE_EXTENSION","value":N,"reason":"..."}`; a reason is mandatory and the override is audited.

---

## 5. Learners: the learning loop **[verified]**

Learners are created by approval (§4). For local development, give the learner a password (real learners use SSO):

```bash
USER_PASSWORD='Learner-Dev-Pass1' npm run user:create -- --email asha@example.org --roles LEARNER      # in platform/api
LEARNER=$(login asha@example.org Learner-Dev-Pass1)
```

### 5.1 My courses and progress

```bash
curl -sS $BASE/v1/me/entitlements -H "Authorization: Bearer $LEARNER" | jq                  # my entitlements
ENT=<entitlementId>
curl -sS $BASE/v1/me/entitlements/$ENT/progress -H "Authorization: Bearer $LEARNER" | jq    # topics, locked/unlocked, videoDone, quiz, complete
```

**Topics unlock in order.** Opening or playing a locked topic returns `403`; there is no way to skip ahead through any endpoint. A topic is complete only when **the video is genuinely watched, in-video questions are answered, the quiz is passed and the assignment is submitted**.

### 5.2 Watching a video

```bash
curl -sS $BASE/v1/topics/$TOPIC_ID -H "Authorization: Bearer $LEARNER" | jq                  # content outline (no answer keys)
curl -sS "$BASE/v1/topics/$TOPIC_ID/playback?mode=low" -H "Authorization: Bearer $LEARNER" | jq   # signed, expiring URLs; mode=low for low bandwidth
```

The player reports what the learner actually watched with **heartbeats** (idempotent; batch-safe for offline resync):

```bash
EVENTS='[{"eventId":"'$(uuidgen | tr A-Z a-z)'","topicId":"'$TOPIC_ID'","type":"VIDEO_HEARTBEAT","occurredAt":"'$(date -u +%FT%TZ)'","payload":{"assetId":"'$ASSET_ID'","from":0,"to":20}}]'
curl -sS -X POST $BASE/v1/learning-events -H "Authorization: Bearer $LEARNER" -H 'Content-Type: application/json' -d "{\"events\":$EVENTS}" | jq
```

Each event result is `accepted`, `duplicate` (same `eventId`; harmless) or `rejected` with a reason (for example `implausible_range`: claiming 100 seconds in one heartbeat is treated as seeking, not watching). Answer an in-video question with an event of type `INTERACTION_RESPONSE` and payload `{"assetId","interactionId":"ix1","response":1}`.

### 5.3 Quiz **[verified]**

```bash
Q=$(curl -sS -X POST $BASE/v1/topics/$TOPIC_ID/quiz/start -H "Authorization: Bearer $LEARNER")     # 409 until the video is watched
ATTEMPT=$(jq -r .attemptId <<<"$Q"); Q1=$(jq -r '.questions[0].id' <<<"$Q"); Q2=$(jq -r '.questions[1].id' <<<"$Q")
curl -sS -X POST $BASE/v1/quiz-attempts/$ATTEMPT/submit -H "Authorization: Bearer $LEARNER" -H 'Content-Type: application/json' \
  -d "{\"answers\":{\"$Q1\":1,\"$Q2\":4}}" | jq        # {passed, scorePercent, attemptsRemaining, rationale (only after passing)}
```

Answer keys and rationales are never sent before an attempt is submitted (and rationales only after passing). Failing consumes an attempt (`maxAttempts`); staff can grant extra attempts with an override.

### 5.4 Assignment **[verified]**

```bash
# text only
curl -sS -X POST $BASE/v1/topics/$TOPIC_ID/assignment/submit -H "Authorization: Bearer $LEARNER" -H 'Content-Type: application/json' \
  -d '{"text":"My answer ..."}' | jq
# with a file: upload first (allowed: pdf, txt, md, png, jpg, zip, ipynb, py, csv, doc/docx, mp4, mp3; scanned for malware), then reference it
F=$(curl -sS -X PUT "$BASE/v1/topics/$TOPIC_ID/assignment/upload?name=notes.pdf" -H "Authorization: Bearer $LEARNER" \
    -H 'Content-Type: application/octet-stream' --data-binary @notes.pdf)
curl -sS -X POST $BASE/v1/topics/$TOPIC_ID/assignment/submit -H "Authorization: Bearer $LEARNER" -H 'Content-Type: application/json' \
  -d "{\"text\":\"see file\",\"files\":[$F]}" | jq
```

Submission requires a passed quiz. On submission the topic completes, the next topic unlocks, and notifications are created (`GET /v1/me/notifications`). Submissions are **append-only evidence**: they cannot be edited or deleted. Grading is covered in §7.

### 5.5 Offline learning **[tested]**

A client registers a device (RSA public key, 2048+ bits, max 3 devices), then requests a time-limited licence for a topic; the licence contains the content key wrapped for that device only. `POST /v1/offline/devices` `{"deviceId","publicKeyPem"}`; `POST /v1/offline/licenses` `{"deviceId","topicId"}`; `GET /v1/offline/licenses`; `POST /v1/offline/devices/<id>/revoke`. Licences expire after `OFFLINE_DAYS` (default 7) and stop working when the entitlement ends.

---

## 6. Tutor and doubt centre

### 6.1 AI tutor **[needs external service]**

A grounded tutor answers only from the learner's own course content and **refuses (and offers a teacher) when the content does not support an answer**. Staff first build the retrieval index once per published version: `POST /v1/tutor/index/<versionId>` (`ACADEMIC_ADMIN`/`PLATFORM_ADMIN`). Consent for AI tutoring must be granted (§8.4) when consent enforcement is on.

```bash
curl -sS -X POST $BASE/v1/tutor/ask -H "Authorization: Bearer $LEARNER" -H 'Content-Type: application/json' \
  -d "{\"question\":\"What does the thermistor measure?\",\"entitlementId\":\"$ENT\",\"topicId\":\"$TOPIC_ID\"}" | jq
curl -sS $BASE/v1/tutor/conversations -H "Authorization: Bearer $LEARNER" | jq
curl -sS -X POST $BASE/v1/tutor/messages/<messageId>/feedback -H "Authorization: Bearer $LEARNER" -H 'Content-Type: application/json' -d '{"helpful":true}'
curl -sS -X POST $BASE/v1/tutor/conversations/<id>/escalate -H "Authorization: Bearer $LEARNER"       # hand the conversation to a teacher
```

After repeated unsupported answers the tutor can open a doubt ticket automatically (`tutor.auto_escalate`).

### 6.2 Doubts (human teachers) **[tested]**

```bash
# learner raises a doubt
curl -sS -X POST $BASE/v1/doubts -H "Authorization: Bearer $LEARNER" -H 'Content-Type: application/json' \
  -d "{\"entitlementId\":\"$ENT\",\"subject\":\"Unstable reading\",\"body\":\"I cannot get a stable reading.\",\"category\":\"CONTENT\",\"topicId\":\"$TOPIC_ID\"}" | jq
curl -sS $BASE/v1/me/doubts -H "Authorization: Bearer $LEARNER" | jq
curl -sS -X POST $BASE/v1/me/doubts/<id>/messages -H "Authorization: Bearer $LEARNER" -H 'Content-Type: application/json' -d '{"body":"More detail ..."}'
curl -sS -X POST $BASE/v1/me/doubts/<id>/rating -H "Authorization: Bearer $LEARNER" -H 'Content-Type: application/json' -d '{"rating":5,"comment":"clear"}'
```

Staff set up teachers once: `PUT /v1/doubt-centre/teachers/<userId>` (admin; skills, disciplines, capacity; the user needs the `DOUBT_TEACHER` role). Tickets are routed automatically by skill, language and load, with an SLA by priority (`doubt.sla_minutes`; breaches are escalated by the worker). A teacher then works the queue:

```bash
T=$(login teacher@institute.edu <password>)
curl -sS $BASE/v1/teacher/tickets -H "Authorization: Bearer $T" | jq
curl -sS -X POST $BASE/v1/teacher/tickets/<id>/claim   -H "Authorization: Bearer $T"
curl -sS -X POST $BASE/v1/teacher/tickets/<id>/reply   -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"body":"Check pin 3."}'      # "internal":true for staff-only notes
curl -sS -X POST $BASE/v1/teacher/tickets/<id>/resolve -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"summary":"Wiring fixed."}'
curl -sS -X POST $BASE/v1/teacher/tickets/<id>/propose-faq -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"question":"...","answer":"..."}'   # reviewed before it is published
```

Learners can also book a short appointment (`POST /v1/me/doubts/<id>/appointments`); teachers confirm with `POST /v1/teacher/appointments/<id>/confirm`.

---

## 7. Grading, moderation, appeals **[tested; AI grading needs external service]**

Authors can define a **grading policy** per assignment (rubric dimensions, weights, confidence threshold, late-penalty rules): `GET|PUT /v1/authoring/topics/<id>/assignment-policy`. On submission, grading is asynchronous:

1. The worker asks the model to grade against the rubric. **Every score must cite verbatim evidence from the submission**, which the platform verifies; unverifiable scores are rejected.
2. Low confidence, integrity flags (similarity to other submissions), or a sampling rule send the work to **human moderation**; if the AI is unavailable after several attempts, the work goes to a teacher.
3. The learner sees the result at `GET /v1/me/submissions/<id>`: score, feedback and who graded it (never similarity or plagiarism details). While pending: "being evaluated".

Moderator (`FACULTY_REVIEWER`) workflow:

```bash
curl -sS $BASE/v1/moderation/queue -H "Authorization: Bearer $FACULTY" | jq
curl -sS -X POST $BASE/v1/moderation/tasks/<id>/claim -H "Authorization: Bearer $FACULTY"
curl -sS $BASE/v1/moderation/tasks/<id> -H "Authorization: Bearer $FACULTY" | jq     # submission, AI grade, evidence, similarity
curl -sS -X POST $BASE/v1/moderation/tasks/<id>/decide -H "Authorization: Bearer $FACULTY" -H 'Content-Type: application/json' \
  -d '{"dimensions":[{"id":"correctness","score":3,"rationale":"good"},{"id":"clarity","score":3}],"feedback":"Well done","reason":"graded manually"}'
# or accept the AI grade after reviewing it:  -d '{"confirmAi":true,"reason":"Reviewed: AI grade is right"}'
```

**Appeals:** the learner appeals a released grade within `grading.appeal_window_days` (`POST /v1/me/submissions/<id>/appeal` with `{"reason":"..."}`); a *different* moderator re-grades. **Overrides** of a final grade need a second administrator to approve: `POST /v1/grading/submissions/<id>/overrides` with `{"dimensions":[{"id":"correctness","score":3}],"reason":"..."}`, then another admin calls `POST /v1/grading/overrides/<id>/decide` with `{"decision":"APPROVE|REJECT","reason":"..."}`. Every change is a new immutable grade record; history at `GET /v1/grading/submissions/<id>/history`. Quality reporting: `GET /v1/reports/grading?days=30`.

Code assignments run in a **container sandbox** (no network, read-only, resource-limited) only when `SANDBOX_MODE=docker`; otherwise they are graded without execution.

---

## 8. Labs and exams

### 8.1 Labs **[tested]**

Authors define lab activities on a version (`PUT /v1/authoring/versions/<id>/labs/<code>`). A `LAB_COORDINATOR` publishes slots (`POST /v1/labs/slots`), prints/shows a rotating QR (`GET /v1/labs/slots/<id>/qr`), and records attendance (`POST /v1/labs/slots/<id>/attendance`). Learners:

```bash
curl -sS $BASE/v1/me/labs -H "Authorization: Bearer $LEARNER" | jq                       # my lab activities and eligibility
curl -sS -X POST $BASE/v1/labs/activities/<id>/ack -H "Authorization: Bearer $LEARNER" -H 'Content-Type: application/json' -d '{"textHash":"<hash of the safety text>"}'
curl -sS -X POST $BASE/v1/labs/slots/<slotId>/book -H "Authorization: Bearer $LEARNER"
curl -sS -X POST $BASE/v1/labs/attendance -H "Authorization: Bearer $LEARNER" -H 'Content-Type: application/json' -d '{"token":"<scanned QR token>"}'
curl -sS -X POST $BASE/v1/labs/bookings/<id>/cancel -H "Authorization: Bearer $LEARNER"   # until lab.cancel_before_hours before the slot
```

### 8.2 Exams: setting up (`EXAM_ADMIN`) **[tested]**

```bash
EXAM_ADMIN=$(login examadmin@institute.edu <password>)
# 1. the question bank per programme (tagged questions the blueprint draws from)
curl -sS -X POST $BASE/v1/exams/bank/<programmeId>/questions -H "Authorization: Bearer $EXAM_ADMIN" -H 'Content-Type: application/json' -d '{"questions":[ ... ]}'
# 2. an exam definition: blueprint of tags and counts, pass mark, attempts, proctoring mode
curl -sS -X POST $BASE/v1/exams -H "Authorization: Bearer $EXAM_ADMIN" -H 'Content-Type: application/json' -d "{
  \"versionId\":\"$VERSION_ID\",\"code\":\"FINAL\",\"title\":\"Final exam\",\"durationMin\":30,\"passPercent\":60,\"maxAttempts\":2,
  \"blueprint\":[{\"tag\":\"sensors\",\"count\":4},{\"tag\":\"networks\",\"count\":3}],
  \"proctoring\":{\"mode\":\"REMOTE\",\"requireId\":true,\"requireDevice\":true,\"device\":{\"camera\":true,\"microphone\":true,\"singleScreen\":true}}}" | jq
# 3. publish it (a DIFFERENT EXAM_ADMIN or ASSESSMENT_ADMIN than the creator), then schedule sessions with a capacity
curl -sS -X POST $BASE/v1/exams/<examId>/publish -H "Authorization: Bearer $ASSESS_ADMIN"
curl -sS -X POST $BASE/v1/exams/<examId>/sessions -H "Authorization: Bearer $EXAM_ADMIN" -H 'Content-Type: application/json' \
  -d '{"startsAt":"2026-12-01T04:00:00Z","endsAt":"2026-12-01T06:00:00Z","mode":"REMOTE","capacity":200}'
```

A blueprint that asks for more questions than the bank holds is flagged at publish. Accommodations (extra time etc.): `POST /v1/exams/accommodations`. `exam.change_freeze` (runtime config) blocks definition/bank/session edits during an exam window.

### 8.3 Exams: taking one (learner) **[tested; remote proctoring needs external service]**

```bash
curl -sS $BASE/v1/me/exams -H "Authorization: Bearer $LEARNER" | jq      # exams, eligibility checks (why you can/cannot sit), sessions, consent text + hash
curl -sS -X POST $BASE/v1/exams/<examId>/register -H "Authorization: Bearer $LEARNER" -H 'Content-Type: application/json' -d '{"sessionId":"<sessionId>"}'
# at the session time: check in with consent (use consent.hash from /v1/me/exams) and the device check result
curl -sS -X POST $BASE/v1/exam-sessions/<sessionId>/check-in -H "Authorization: Bearer $LEARNER" -H 'Content-Type: application/json' \
  -d '{"consent":true,"consentHash":"<hash>","device":{"browserSupported":true,"camera":true,"microphone":true,"screens":1,"bandwidthKbps":2000}}' | jq     # returns attemptId
# identity is verified by the proctoring provider (webhook) or, for centre exams, by an invigilator (POST /v1/proctor/attempts/<id>/verify-id)
curl -sS -X POST $BASE/v1/exam-attempts/<attemptId>/start  -H "Authorization: Bearer $LEARNER" | jq      # returns the paper, the deadline and a sessionToken
curl -sS -X PUT  $BASE/v1/exam-attempts/<attemptId>/answers -H "Authorization: Bearer $LEARNER" -H "X-Exam-Session: <sessionToken>" \
  -H 'Content-Type: application/json' -d '{"seq":1,"answers":{"<questionId>":1}}'          # autosave: send increasing "seq"; resending is safe
curl -sS -X POST $BASE/v1/exam-attempts/<attemptId>/submit -H "Authorization: Bearer $LEARNER" -H "X-Exam-Session: <sessionToken>" | jq    # signed receipt
```

The **server clock** controls the deadline; autosaves are idempotent by `seq`; a second device or tab takes over the session and the previous one is refused (counted as a signal). A paper is a seeded selection from the bank, so the same learner and attempt always get the same paper. After submission the result is **held** until proctoring review and release by staff; the learner then sees it at `GET /v1/me/exam-attempts/<id>` and may appeal (`POST /v1/me/exam-attempts/<id>/appeal` `{"reason":"..."}`).

### 8.4 Exam operations (staff) **[tested]**

```bash
curl -sS $BASE/v1/exam-ops/status -H "Authorization: Bearer $EXAM_ADMIN" | jq     # live dashboard: in progress, stale autosaves, expiring, incidents, held results
curl -sS $BASE/v1/exam-ops/incidents -H "Authorization: Bearer $EXAM_ADMIN" | jq
curl -sS -X POST $BASE/v1/exam-ops/incidents/<id>/decide -H "Authorization: Bearer $EXAM_ADMIN" -H 'Content-Type: application/json' -d '{"decision":"DISMISSED","reason":"..."}'      # DISMISSED | CONFIRMED_MINOR | CONFIRMED_MAJOR | NEEDS_INFO (not the person who recorded it)
curl -sS -X POST $BASE/v1/exam-ops/sessions/<sessionId>/release-ready -H "Authorization: Bearer $EXAM_ADMIN"      # release results that are ready
curl -sS "$BASE/v1/reports/exams?examId=<examId>" -H "Authorization: Bearer $EXAM_ADMIN" | jq    # results, item analysis, integrity, appeals
```

The proctoring vendor posts signed results to `POST /v1/proctoring/webhook`; the contract is in [`../proctor-provider-contract.md`](../proctor-provider-contract.md). Without a vendor configured, an in-process **mock** provider is used (development only).

---

## 9. Operations

### 9.1 Reports **[verified / tested]**

```bash
curl -sS "$BASE/v1/reports/progress?versionId=$VERSION_ID&limit=200" -H "Authorization: Bearer $ADMIN" | jq     # cohort progress, at-risk flag (page + nextCursor)
curl -sS "$BASE/v1/reports/progress?versionId=$VERSION_ID&format=csv" -H "Authorization: Bearer $ADMIN" > progress.csv    # full export (audited)
curl -sS "$BASE/v1/reports/tutor?days=30"  -H "Authorization: Bearer $ADMIN" | jq
curl -sS "$BASE/v1/reports/doubts?days=30" -H "Authorization: Bearer $ADMIN" | jq
curl -sS "$BASE/v1/reports/grading?days=30" -H "Authorization: Bearer $ADMIN" | jq
```

### 9.2 Audit trail and integrity **[verified]**

```bash
AUDITOR=$(login auditor@synthetic.test)
curl -sS "$BASE/v1/audit?objectType=ProgrammeVersion&objectId=$VERSION_ID" -H "Authorization: Bearer $AUDITOR" | jq    # who did what, when, why (latest 200)
curl -sS $BASE/v1/audit/verify -H "Authorization: Bearer $AUDITOR" | jq               # {events, intact:true}: the whole hash chain re-computed
PLATFORM=$(login platform@synthetic.test)
curl -sS $BASE/v1/ops/integrity -H "Authorization: Bearer $PLATFORM" | jq             # audit chain + every exam log + referential checks
```

`intact:false` or `ok:false` is a **security incident**: follow the runbook in [`../ops/runbooks.md`](../ops/runbooks.md). The worker also runs this check every 6 hours and exports it as the `integrity_ok` metric.

### 9.3 Runtime configuration and the kill switch **[verified]**

```bash
curl -sS $BASE/v1/admin/config -H "Authorization: Bearer $PLATFORM" | jq                      # every setting, its description and current value
curl -sS -X PUT $BASE/v1/admin/config/ai.kill_switch -H "Authorization: Bearer $PLATFORM" -H 'Content-Type: application/json' -d '{"value":true}'    # stop ALL model calls now
curl -sS -X PUT $BASE/v1/admin/config/ai.daily_budget_usd -H "Authorization: Bearer $PLATFORM" -H 'Content-Type: application/json' -d '{"value":50}'
curl -sS -X PUT $BASE/v1/admin/config/exam.change_freeze -H "Authorization: Bearer $PLATFORM" -H 'Content-Type: application/json' -d '{"value":true}'  # during an exam window
```

All keys are listed in the [configuration reference](04-configuration-reference.md#runtime-settings-put-v1adminconfigkey). Values are validated by type; every change is audited.

### 9.4 Privacy: consent, export, correction, erasure **[tested]**

Learners (or support on their behalf) exercise their rights through requests:

```bash
curl -sS -X POST $BASE/v1/me/privacy/requests -H "Authorization: Bearer $LEARNER" -H 'Content-Type: application/json' \
  -d '{"type":"EXPORT","password":"Learner-Dev-Pass1"}' | jq        # type: EXPORT | CORRECTION | ERASURE (re-authentication required)
curl -sS $BASE/v1/me/privacy/requests -H "Authorization: Bearer $LEARNER" | jq
# staff: decide (a DIFFERENT person than the requester), then the worker processes it (or run it now)
curl -sS $BASE/v1/privacy/requests?status=REQUESTED -H "Authorization: Bearer $PLATFORM" | jq
curl -sS -X POST $BASE/v1/privacy/requests/<id>/decide -H "Authorization: Bearer $PLATFORM" -H 'Content-Type: application/json' -d '{"decision":"APPROVE","reason":"identity verified"}'      # APPROVE | REJECT
curl -sS -X POST $BASE/v1/privacy/process -H "Authorization: Bearer $PLATFORM"
curl -sS -OJ $BASE/v1/me/privacy/requests/<id>/download -H "Authorization: Bearer $LEARNER"      # the export; encrypted at rest, expires after 7 days
```

Erasure is blocked while a live entitlement or a **legal hold** exists (`PUT /v1/privacy/users/<id>/legal-hold`); it keeps the pseudonymised academic record and asks the proctoring vendor to delete its copy. Retention sweeps run daily; preview with `POST /v1/privacy/retention/run?dryRun=true`. Accessibility preferences (captions, text spacing, language) are saved per learner on the server.

### 9.5 Health, metrics, and what to watch

| URL | Purpose |
|---|---|
| `GET /health` | process is alive |
| `GET /health/ready` | database reachable (use this for load-balancer health checks) |
| `GET /metrics` | Prometheus metrics; requires `Authorization: Bearer $METRICS_TOKEN` |

Alert rules and a dashboard are in `platform/ops/` ([operations](../ops/slo-and-alerts.md)); on-call actions are in the [runbooks](../ops/runbooks.md).

---

## 10. Common questions

**A learner cannot open a topic (403).** The previous topic is incomplete (video, in-video question, quiz or assignment missing), or the entitlement is paused, expired or revoked. `GET /v1/entitlements/<id>/access` states the reason.

**Quiz start returns 409.** The video has not been watched for real yet, or an in-video question is unanswered, or the quiz is already passed, or attempts are used up.

**An import says `duplicate`.** The same `externalRef` was already received. This is the safe-retry behaviour, not an error.

**Approval returns 409 "no published course version".** Publish a version for that programme code first (§3).

**Login returns 401 for a correct password.** The account is locked after 5 failures (wait 15 minutes), the user has no password (a learner who should use SSO), or MFA enrolment is required (look for `mfaEnrollmentRequired` in the body).

**429 Too Many Requests.** Wait for the seconds in `Retry-After`. Limits are per IP, per user and stricter for sign-in.

**Where do I find an endpoint?** [`api-reference.md`](api-reference.md) lists all 202 routes with the roles allowed; [`../api-inventory.json`](../api-inventory.json) is the reviewed contract that tests enforce.
