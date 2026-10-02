# Security review (internal, Phase 7). This is NOT an independent penetration test.

**Status for Gate 6: not met.** The build prompt requires "no open critical/high findings" after independent review. This document records
the internal review and automated checks; an external penetration test, cloud configuration review and mobile-app review remain open.

## Method
Code review of authentication, authorization, input handling, crypto, file handling and integrations; automated route-level authorization
audit (`test/security.spec.ts`); dependency audit; runtime checks with hostile inputs; threat model (`threat-model.md`).

## Findings and dispositions
| # | Finding | Severity | Disposition |
|---|---|---|---|
| S-1 | `/auth/login` had no brute-force protection and no refresh/revocation; tokens lived 15 min with no kill switch | High | **Fixed**: lockout, rate limits, sessions, rotating refresh, admin revoke |
| S-2 | No MFA for privileged roles despite requirement IAM-006 | High | **Fixed**: TOTP + backup codes; enforced in production |
| S-3 | `scryptSync` on the request thread: a login burst could stall the whole instance (availability) | Medium | **Fixed**: async hashing, bounded concurrency |
| S-4 | No security headers, CORS policy, body limit or correlation-id validation | Medium | **Fixed** |
| S-5 | Probe/health exemption and media cache rule silently never matched because Nest middleware exposes a mount-relative `req.path` | Medium | **Fixed** (found by test) |
| S-6 | Audit record of a *denied* evidence access was rolled back with the thrown error | Medium | **Fixed** in Phase 6 |
| S-7 | Dev defaults (`dev-only` secrets) could ship to production | High | **Fixed**: boot guard refuses unsafe production config |
| S-8 | Evidence tables could not be redacted for erasure without weakening immutability | Medium | **Fixed**: transaction-local `app.erasure` bypass, tested to stay closed otherwise |
| S-9 | `deepmerge-ts` < 8 (GHSA-ggr8-5vv4-36mx) via Prisma CLI config loader | High (build-time only) | **Fixed** via npm override; `npm audit`: 0 vulnerabilities |
| S-10 | Malware scanning of uploads | High for launch | **MITIGATED IN CODE, UNVERIFIED LIVE** - clamd INSTREAM adapter, fails closed (infected 400, scanner down 503), production guard requires `SCANNER=clamav`; tested against a protocol fake only; files over `SCAN_MAX_BYTES` (25 MB, staff video masters) are recorded `skipped_oversize` in the audit trail |
| S-11 | Docker sandbox unreviewed and never executed | High if enabled | **OPEN** (disabled by default; do not enable without review) |
| S-12 | Secrets in env vars, no rotation | Medium | **OPEN**: KMS/HSM + rotation runbook |
| S-13 | Rate limits/session cache are per instance | Medium | **OPEN**: Redis-backed store for the cluster |
| S-14 | Anchoring audit hash chain externally (insider with DB superuser) | Medium | **OPEN**: periodic head-hash export to WORM storage |
| S-15 | No WAF, TLS termination, network segmentation reviewed (no infrastructure exists yet) | n/a | **OPEN** |
| S-16 | SAML not implemented | Low | Use an OIDC broker |
| S-17 | No breached-password screening, no WebAuthn | Low | Backlog |

## Automated evidence
- 202 routes inventoried (`docs/api-inventory.json`): 13 public (each with its own verification), 16 self-scoped, the rest role-restricted;
  every non-public route returns 401 anonymously; every role-restricted route returns 403 to a user without the role.
- Hostile-input tests: oversized body (413), malformed JSON (400), type confusion (400), SQL-metacharacters in query strings (no effect).
- `npm audit --omit=dev`: 0 vulnerabilities (2026-10-02). CI adds secret scanning, CodeQL and container scanning (not yet executed).

## Required before launch
Independent penetration test (web, API, mobile, cloud), remediation of all critical/high findings, fix S-10/S-12/S-13/S-14,
sandbox review (if enabled), vendor security due diligence (AI providers, proctoring), tabletop incident exercise.
