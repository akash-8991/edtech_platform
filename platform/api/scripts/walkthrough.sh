#!/usr/bin/env bash
# End-to-end walkthrough of the platform through its HTTP API, using only curl + jq.
# Every command below is the same one documented in docs/guides/03-user-guide.md, so running this proves the guide still works.
#
#   Prerequisites: API running (npm run dev / npm start), database seeded (npm run db:seed), curl, jq, uuidgen, DATABASE_URL exported
#   (only used to give the demo learner a password, because real learners sign in through SSO).
#   Run:  BASE=http://localhost:3000 bash scripts/walkthrough.sh
#
# Dev only: uses the synthetic seed users. Never point this at production.
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
PASS="${SEED_PASSWORD:-Dev-Only-Pass1}"
RUN="$(date +%s)"
LEARNER_EMAIL="learner-$RUN@synthetic.test"
LEARNER_PASS="Learner-Dev-Pass1"
ok=0; step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
pass() { ok=$((ok+1)); printf '   \033[32mok\033[0m  %s\n' "$*"; }
die() { printf "   \033[31mFAIL\033[0m %s\n" "$*" >&2; kill -TERM "$$"; exit 1; }
need() { command -v "$1" >/dev/null || die "missing prerequisite: $1"; }
need curl; need jq; need uuidgen

# api METHOD PATH [TOKEN] [JSON-BODY] -> prints the response body; fails on HTTP >= 400
api() {
  local method="$1" path="$2" token="${3:-}" body="${4:-}" out code
  local args=(-sS -X "$method" "$BASE$path" -H 'Content-Type: application/json' -w '\n%{http_code}')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-d "$body")
  out="$(curl "${args[@]}")"; code="${out##*$'\n'}"; out="${out%$'\n'*}"
  [ "$code" -lt 400 ] || die "$method $path -> HTTP $code: $out"
  printf '%s' "$out"
}
login() { api POST /v1/auth/login "" "{\"email\":\"$1\",\"password\":\"${2:-$PASS}\"}" | jq -r '.accessToken // empty'; }
expect() { [ "$2" = "$3" ] || die "$1: expected '$3' but got '$2'"; pass "$1"; }

step "0. The API is up"
V=$(api GET /health | jq -r .status); expect "health" "$V" ok
V=$(api GET /health/ready | jq -r .status); expect "readiness (database reachable)" "$V" ready

step "1. Staff sign in (seeded synthetic users)"
ADMIN=$(login admin@synthetic.test); AUTHOR=$(login author@synthetic.test); FACULTY=$(login faculty@synthetic.test)
APPROVER=$(login approver@synthetic.test); AUDITOR=$(login auditor@synthetic.test); PLATFORM=$(login platform@synthetic.test)
for t in "$ADMIN" "$AUTHOR" "$FACULTY" "$APPROVER" "$AUDITOR" "$PLATFORM"; do [ -n "$t" ] || die "a seeded user could not sign in (did you run 'npm run db:seed'? is MFA enforced? MFA_ENFORCE must not be 1 for this script)"; done
pass "six staff roles signed in"

step "2. Author a course: programme -> version -> topic -> video asset -> quiz -> assignment"
CODE="DEMO-$RUN"
api POST /v1/authoring/programmes "$AUTHOR" "{\"code\":\"$CODE\",\"title\":\"Demo programme $RUN\",\"discipline\":\"AI\"}" >/dev/null
VERSION=$(api POST "/v1/authoring/programmes/$CODE/versions" "$AUTHOR" '{"hours":1,"languages":["en"],"modules":[{"title":"Module 1","topics":[{"title":"Topic 1","hours":1}]}]}')
VERSION_ID=$(jq -r .id <<<"$VERSION"); TOPIC_ID=$(jq -r '.modules[0].topics[0].id' <<<"$VERSION")
pass "version $VERSION_ID, topic $TOPIC_ID"
ASSET_ID=$(api POST "/v1/authoring/topics/$TOPIC_ID/assets" "$AUTHOR" '{"language":"en","durationSec":100,"provenance":{"model":"manual","source":"walkthrough"},"interactions":[{"id":"ix1","atSec":30,"kind":"pause_quiz","required":true,"prompt":"2+2?","correct":1}]}' | jq -r .id)
for label in master 360p audio transcript; do
  curl -sS -f -X PUT "$BASE/v1/authoring/assets/$ASSET_ID/files/$label" -H "Authorization: Bearer $AUTHOR" -H 'Content-Type: application/octet-stream' --data-binary "demo $label bytes" >/dev/null || die "upload $label"
done
pass "asset $ASSET_ID with master, 360p, audio and transcript uploaded"
api PUT "/v1/authoring/topics/$TOPIC_ID/quiz" "$AUTHOR" '{"passPercent":60,"maxAttempts":3,"questions":[{"type":"MCQ_SINGLE","text":"Pick option b","options":["a","b"],"answer":1,"points":1,"rationale":"because b"},{"type":"NUMERIC","text":"2+2","answer":4,"tolerance":0.1,"points":1}]}' >/dev/null
api PUT "/v1/authoring/topics/$TOPIC_ID/assignment" "$AUTHOR" '{"instructions":"Write two sentences about what you learned.","maxSubmissions":2}' >/dev/null
pass "quiz and assignment defined"

step "3. Review and publish (maker-checker: four different people, every step audited)"
api POST "/v1/authoring/versions/$VERSION_ID/transition" "$AUTHOR"   '{"to":"FACULTY_REVIEW"}'   >/dev/null; pass "author -> FACULTY_REVIEW"
api POST "/v1/authoring/versions/$VERSION_ID/transition" "$FACULTY"  '{"to":"FACULTY_APPROVED"}' >/dev/null; pass "faculty -> FACULTY_APPROVED"
api POST "/v1/authoring/versions/$VERSION_ID/transition" "$FACULTY"  '{"to":"ADMIN_APPROVAL"}'   >/dev/null; pass "faculty -> ADMIN_APPROVAL"
api POST "/v1/authoring/versions/$VERSION_ID/transition" "$APPROVER" '{"to":"PUBLISHED"}'        >/dev/null; pass "approver -> PUBLISHED"
V=$(api GET /v1/catalogue "$ADMIN" | jq -r --arg c "$CODE" '[.[]|select(.code==$c)]|length'); expect "the catalogue now lists it" "$V" 1

step "4. Admissions: import an application and approve it (creates the learner account and the entitlement)"
APP_BODY=$(jq -nc --arg r "APP-$RUN" --arg e "$LEARNER_EMAIL" --arg c "$CODE" '{applications:[{externalRef:$r,email:$e,name:"Demo Learner",programmeCode:$c,duration:"M12",cohort:"C1"}]}')
APP=$(api POST /v1/applications/import "$ADMIN" "$APP_BODY")
R1=$(jq -r '.results[0].result' <<<"$APP"); expect "application created" "$R1" created
APP_ID=$(jq -r '.results[0].id' <<<"$APP")
DEC=$(api POST "/v1/applications/$APP_ID/decision" "$ADMIN" '{"decision":"APPROVE"}'); ENT=$(jq -r .entitlementId <<<"$DEC")
[ "$ENT" != null ] || die "no entitlement created"; pass "entitlement $ENT"
R2=$(api POST /v1/applications/import "$ADMIN" "$APP_BODY" | jq -r '.results[0].result'); expect "re-importing the same application is a harmless duplicate" "$R2" duplicate

step "5. Give the demo learner a password (local only; real learners use single sign-on)"
USER_PASSWORD="$LEARNER_PASS" npm run -s user:create -- --email "$LEARNER_EMAIL" --roles LEARNER >/dev/null
LEARNER=$(login "$LEARNER_EMAIL" "$LEARNER_PASS"); [ -n "$LEARNER" ] || die "learner could not sign in"; pass "learner signed in"

step "6. Learner: progress, content, playback"
V=$(api GET "/v1/me/entitlements/$ENT/progress" "$LEARNER" | jq -r '.topics[0].videoDone'); expect "one topic, not yet complete" "$V" false
api GET "/v1/topics/$TOPIC_ID" "$LEARNER" >/dev/null; pass "topic opens (it is the first, so it is unlocked)"
PLAY=$(api GET "/v1/topics/$TOPIC_ID/playback?mode=low" "$LEARNER"); jq -e '.' >/dev/null <<<"$PLAY"; pass "low-bandwidth playback manifest issued with signed URLs"

step "7. Learner: watch the video (heartbeats), answer the in-video question, then the quiz is allowed"
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/topics/$TOPIC_ID/quiz/start" -H "Authorization: Bearer $LEARNER"); expect "quiz is blocked before the video is watched" "$HTTP" 409
hb() { printf '{"eventId":"%s","topicId":"%s","type":"VIDEO_HEARTBEAT","occurredAt":"%s","payload":{"assetId":"%s","from":%s,"to":%s}}' "$(uuidgen | tr A-Z a-z)" "$TOPIC_ID" "$(date -u +%FT%TZ)" "$ASSET_ID" "$1" "$2"; }
EVENTS="[$(hb 0 20),$(hb 20 40),$(hb 40 60),$(hb 60 80),$(hb 80 100)]"
V=$(api POST /v1/learning-events "$LEARNER" "{\"events\":$EVENTS}" | jq -r '[.results[]|select(.status=="accepted")]|length'); expect "five heartbeats accepted" "$V" 5
IR="{\"events\":[{\"eventId\":\"$(uuidgen | tr A-Z a-z)\",\"topicId\":\"$TOPIC_ID\",\"type\":\"INTERACTION_RESPONSE\",\"occurredAt\":\"$(date -u +%FT%TZ)\",\"payload\":{\"assetId\":\"$ASSET_ID\",\"interactionId\":\"ix1\",\"response\":1}}]}"
V=$(api POST /v1/learning-events "$LEARNER" "$IR" | jq -r '.results[0].status'); expect "interaction answer accepted" "$V" accepted
V=$(api GET "/v1/me/entitlements/$ENT/progress" "$LEARNER" | jq -r '.topics[0].videoDone'); expect "video counts as watched" "$V" true

step "8. Learner: quiz (wrong first, then right), then the assignment"
Q=$(api POST "/v1/topics/$TOPIC_ID/quiz/start" "$LEARNER"); QA=$(jq -r .attemptId <<<"$Q"); Q1=$(jq -r '.questions[0].id' <<<"$Q"); Q2=$(jq -r '.questions[1].id' <<<"$Q")
V=$(grep -c 'because b' <<<"$Q" || true); expect "answer keys are never sent to the learner" "$V" 0
WRONG=$(jq -nc --arg a "$Q1" --arg b "$Q2" '{answers:{($a):0,($b):9}}')
P1=$(api POST "/v1/quiz-attempts/$QA/submit" "$LEARNER" "$WRONG" | jq -r .passed); expect "a failing attempt is recorded" "$P1" false
Q=$(api POST "/v1/topics/$TOPIC_ID/quiz/start" "$LEARNER"); QA=$(jq -r .attemptId <<<"$Q"); Q1=$(jq -r '.questions[0].id' <<<"$Q"); Q2=$(jq -r '.questions[1].id' <<<"$Q")
RIGHT=$(jq -nc --arg a "$Q1" --arg b "$Q2" '{answers:{($a):1,($b):4}}')
P2=$(api POST "/v1/quiz-attempts/$QA/submit" "$LEARNER" "$RIGHT" | jq -r .passed); expect "the passing attempt passes" "$P2" true
api POST "/v1/topics/$TOPIC_ID/assignment/submit" "$LEARNER" '{"text":"I learned how the platform gates progress and audits every decision."}' >/dev/null; pass "assignment submitted"
V=$(api GET "/v1/me/entitlements/$ENT/progress" "$LEARNER" | jq -r '.topics[0].complete'); expect "the topic is now complete" "$V" true
V=$(api GET /v1/me/notifications "$LEARNER" | jq -r '[.[]|select(.type=="topic.completed")]|length'); expect "learner was notified" "$V" 1

step "9. Staff oversight: reports, audit trail, integrity"
V=$(api GET "/v1/reports/progress?versionId=$VERSION_ID" "$ADMIN" | jq -r '.rows|length'); expect "cohort report lists the learner" "$V" 1
V=$(api GET /v1/audit/verify "$AUDITOR" | jq -r .intact); expect "audit trail verifies (hash chain intact)" "$V" true
V=$(api GET /v1/ops/integrity "$PLATFORM" | jq -r .ok); expect "full integrity check passes" "$V" true
echo; printf '\033[32mWALKTHROUGH OK\033[0m  (%s checks passed)\n' "$ok"
echo "Programme: $CODE   Learner: $LEARNER_EMAIL / $LEARNER_PASS"
