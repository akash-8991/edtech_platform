# Secret and key rotation

Every secret has `NAME` (current, signs/encrypts) and optional `NAME_PREVIOUS` (comma-separated retired values, accepted for verification/decryption only). Secrets are loaded from the secret store at boot (`SECRETS_MANAGER_SECRET_ID`, AWS Secrets Manager JSON, vault values override the manifest; the process refuses to start if the configured entry cannot be read).

| Secret | Used for | Rotation procedure | Impact |
|---|---|---|---|
| `JWT_SECRET` | access tokens, MFA/enrolment tokens | Set `JWT_SECRET_PREVIOUS=<old>`, `JWT_SECRET=<new>`, deploy; after the longest access-token lifetime (15 min; MFA tokens 5 min) remove `_PREVIOUS` | None for users |
| `MEDIA_TOKEN_SECRET`, `LAB_QR_SECRET` | signed playback/lab QR tokens (minutes) | Same overlap pattern | None |
| `DATA_ENC_KEY` | sealed TOTP seeds, privacy export keys | `DATA_ENC_KEY_PREVIOUS=<old>`, set new, deploy, run `npx ts-node scripts/rotate-keys.ts` (idempotent; `DRY_RUN=1` first), confirm `failed: []`, then drop `_PREVIOUS` | None |
| `OFFLINE_MASTER_KEY` | wraps offline-package content keys | Same as `DATA_ENC_KEY` (the script re-wraps `OfflinePackage.wrappedKey`) | None; already-issued device licences are unaffected (they hold the device-wrapped content key) |
| `ADMISSIONS_HMAC_SECRET`, `PROCTOR_WEBHOOK_SECRET`, `PROCTOR_API_KEY`, `METRICS_TOKEN`, AI keys | inbound/outbound integrations | Coordinate with the counterparty: they sign with the new value; **inbound HMAC currently accepts one secret, so rotate in a maintenance window or ask the sender to dual-sign** | Brief rejection window |
| `EXAM_RECEIPT_SECRET` | exam receipt codes and the pseudonymous learner token sent to the proctoring vendor | **Not rotatable without a migration**: receipt codes are stored, but the vendor pseudonym is derived from the secret, so rotating it changes the learner identity the vendor holds. Treat as long-lived; rotate only with a vendor re-mapping plan | - |

Rotation is tested end to end for JWT (a live session survives rotation and stops working once the old key is dropped), signed tokens, and data keys (`test/p1.spec.ts`). Running it against a real KMS/Secrets Manager has not been done. Data keys are still plain 256-bit values in the secret store, not KMS envelope keys: moving to KMS-wrapped data keys is the production target.
