#!/usr/bin/env bash
# Encrypted logical backup of the database + media store. Usage: BACKUP_PASSPHRASE=... DATABASE_URL=... MEDIA_ROOT=... scripts/dr/backup.sh <out-dir>
# Production: run from a locked-down job with the passphrase in a secret manager, write to an India-region bucket with object lock/versioning,
# and prefer continuous WAL archiving (PITR) for the 15-minute RPO; this logical dump is the portable, verifiable fallback.
set -euo pipefail
OUT="${1:?output dir}"; : "${DATABASE_URL:?}"; : "${BACKUP_PASSPHRASE:?}"
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
mkdir -p "$OUT"; TS=$(date -u +%Y%m%dT%H%M%SZ); D="$OUT/$TS"; mkdir -p "$D"
t0=$(date +%s)
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$D/db.dump.enc"
if [ -n "${MEDIA_ROOT:-}" ] && [ -d "$MEDIA_ROOT" ]; then tar -C "$MEDIA_ROOT" -cf - . | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$D/media.tar.enc"; fi
( cd "$D" && shasum -a 256 *.enc > SHA256SUMS )
t1=$(date +%s); echo "{\"backup\":\"$D\",\"seconds\":$((t1-t0)),\"bytes\":$(du -sk "$D" | cut -f1)000}" > "$D/manifest.json"
echo "$D"
