#!/usr/bin/env bash
# Disaster-recovery drill: encrypted backup -> restore into a scratch database -> verify integrity + row parity -> report timings.
# Usage: SOURCE_DB=edtech_test BACKUP_PASSPHRASE=... scripts/dr/restore-drill.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
SRC_DB="${SOURCE_DB:-edtech_test}"; HOST="${PGHOST_URL:-localhost:5433}"; USER_PW="${PGAUTH:-edtech:edtech}"; SCRATCH="drill_restore_$(date +%s)"
SOURCE_URL="postgresql://${USER_PW}@${HOST}/${SRC_DB}"; TARGET_URL="postgresql://${USER_PW}@${HOST}/${SCRATCH}"
export BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-$(openssl rand -hex 24)}"
WORK="$(mktemp -d)"; trap 'psql -h localhost -p 5433 -U edtech -d postgres -qc "DROP DATABASE IF EXISTS \"$SCRATCH\"" >/dev/null 2>&1; rm -rf "$WORK"' EXIT
echo ">> backup of $SRC_DB"; B=$(DATABASE_URL="$SOURCE_URL" MEDIA_ROOT="${MEDIA_ROOT:-}" scripts/dr/backup.sh "$WORK/backups" | tail -1)
BACKUP_S=$(python3 -c "import json;print(json.load(open('$B/manifest.json'))['seconds'])")
echo ">> verify backup checksums"; ( cd "$B" && shasum -a 256 -c SHA256SUMS )
echo ">> restore into scratch database $SCRATCH"; psql -h localhost -p 5433 -U edtech -d postgres -qc "CREATE DATABASE \"$SCRATCH\""
t0=$(date +%s)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$B/db.dump.enc" | pg_restore --no-owner --no-privileges -d "$TARGET_URL"
RESTORE_S=$(( $(date +%s) - t0 ))
echo ">> verify restored database"; V=$(SOURCE_URL="$SOURCE_URL" TARGET_URL="$TARGET_URL" npx ts-node scripts/dr/verify-restore.ts | tail -1); echo "$V"
OK=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['ok'])" "$V")
python3 - "$V" "$BACKUP_S" "$RESTORE_S" "$SRC_DB" <<'PY'
import json,sys,datetime,os
v=json.loads(sys.argv[1]); rep={"when":datetime.datetime.now(datetime.timezone.utc).isoformat(),"sourceDatabase":sys.argv[4],"backupSeconds":int(sys.argv[2]),"restoreSeconds":int(sys.argv[3]),"verifySeconds":v["verifySeconds"],
 "measuredRtoSeconds":int(sys.argv[3])+v["verifySeconds"],"tables":v["rowCounts"]["tables"],"rows":v["rowCounts"]["rows"],"auditEventsVerified":v["integrity"]["audit"]["events"],"examLogChainsVerified":v["integrity"]["examLogs"]["attempts"],
 "immutabilityTriggersPresent":v["immutabilityTriggersPresent"],"rowCountMismatches":v["rowCounts"]["mismatched"],"integrityOk":v["integrity"]["ok"],"passed":v["ok"],
 "scope":"single-node logical backup/restore on a developer machine; NOT a cloud DR drill (no cross-region, no PITR, no media restore at scale)"}
os.makedirs("../docs/dr",exist_ok=True); open("../docs/dr/drill-%s-%s.json"%(datetime.date.today().isoformat(),sys.argv[4]),"w").write(json.dumps(rep,indent=1)); print(json.dumps(rep,indent=1))
PY
[ "$OK" = "True" ] || { echo "DRILL FAILED"; exit 2; }; echo "DRILL PASSED"
