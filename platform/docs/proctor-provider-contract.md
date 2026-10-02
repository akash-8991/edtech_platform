# Proctoring provider contract (v1)

The platform talks to any proctoring vendor through `ProctorProvider` (src/proctoring/provider.ts). The generic REST adapter expects the
following. Run `proctorContract(provider)` (exported from the same file) against the vendor sandbox before go-live; it must return `[]`.

**Privacy:** the vendor never receives the learner's name, email or platform id. It gets `learnerToken` (HMAC, opaque, stable per learner)
and `consent: true`. Identity matching against a government ID is performed by the vendor on its own side and reported as an event.

## Outbound (platform -> vendor), `Authorization: Bearer <PROCTOR_API_KEY>`
| Call | Body / notes |
|------|--------------|
| `POST /sessions` | `{attemptId, examCode, learnerToken, mode:"REMOTE", startsAt, endsAt, consent:true, checks:{identity,device}}` -> `{sessionId, launchUrl}`. **Idempotent per `attemptId`** (`Idempotency-Key` header = attemptId). |
| `DELETE /sessions/:id` | Cancel; 204. |
| `GET /sessions/:id/report` | `{final:boolean, incidents:[{eventId,type,severity,occurredAt,evidenceUrl?,evidenceExpiresAt?}]}`. Used as a fallback when a webhook is lost. |

## Inbound (vendor -> platform): `POST /v1/proctoring/webhook`
Headers `x-timestamp` (ms epoch, within 5 minutes) and `x-signature` = hex HMAC-SHA256(`PROCTOR_WEBHOOK_SECRET`, `<timestamp>.<raw body>`).
Body: `{eventId (unique, replay-safe), sessionId, type, occurredAt, ...}`

| `type` | Extra fields | Effect |
|--------|--------------|--------|
| `identity_verified` | | marks identity check VERIFIED |
| `identity_failed` | `detail.reason` | marks FAILED + HIGH incident |
| `incident` | `incidentType`, `severity` LOW/MEDIUM/HIGH/CRITICAL, `evidenceUrl` (https only), `evidenceExpiresAt` | opens an incident; result is held |
| `report_final` | | provider has no further findings; remote result may become READY |

Evidence URLs must be https and short-lived; the platform stores them, serves them only to adjudicators, and logs every access.
