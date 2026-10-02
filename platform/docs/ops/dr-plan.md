# Disaster-recovery plan

**Targets (TRD):** transactional services RPO <= 15 min, RTO <= 2 h; media masters RPO <= 24 h.

## Design
- PostgreSQL: managed multi-AZ HA + continuous WAL archiving (PITR) to a second India location; daily encrypted logical dump as a portable,
  independently verifiable fallback (`scripts/dr/backup.sh`).
- Object storage (masters, submissions, evidence, exports): versioning + cross-region replication; encrypted offline packages are derived
  and can be regenerated; the offline master key is escrowed in KMS.
- Secrets and keys: KMS/HSM with documented rotation; **losing `DATA_ENC_KEY`/`OFFLINE_MASTER_KEY` makes TOTP seeds, exports and offline
  packages unrecoverable**, so key backup is part of DR.
- Stateless API/workers: rebuilt from images; workers are idempotent (job claim with `SKIP LOCKED`, requeue on crash).

## Restore procedure
1. Declare disaster; freeze writes. 2. Provision DB from PITR/dump. 3. `npx prisma migrate deploy`. 4. Run `scripts/dr/verify-restore.ts`
(chains, orphans, row parity, **immutability triggers present**). 5. `GET /v1/ops/integrity`. 6. Restore media, verify checksums. 7. Reconcile
the RPO gap: learning events carry client UUIDs and are replayed idempotently by clients; exam autosaves resync by `seq`; incomplete
grading jobs re-enter the queue. 8. Resume traffic; post-incident review.

## Drill evidence (2026-10-02)
`docs/dr/drill-2026-10-02-*.json`: encrypted backup -> checksum verify -> restore to a scratch database -> integrity verification.
| Dataset | Rows | Restore | Verify | Result |
|---|---:|---:|---:|---|
| `edtech_test` (62 audit events, grading data) | 633 | ~1 s | 0.15 s | passed, exact row parity, 11/11 immutability triggers present |
| `edtech_perf` (600 users, 12,404 events, 600 exam-log chains) | 20,631 | ~1 s | 0.31 s | passed |

**This is a single-node logical drill.** It does not prove PITR, cross-region failover, media restore at scale, key recovery, or the
15-minute RPO. A cloud drill with a signed report is a Gate 6/7 requirement.
