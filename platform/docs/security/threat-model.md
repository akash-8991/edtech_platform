# Threat model (STRIDE, by asset) - Phase 7

Scope: the API and its integrations. Client apps, cloud network, IaC and the proctoring vendor are not yet built/selected and need their
own model. "Control" lists what exists in code; "Residual" is what remains.

| Asset / flow | Threat | Control (in code) | Residual risk |
|---|---|---|---|
| Sign-in | Credential stuffing, brute force | per-IP + per-account rate limits, lockout after 5 failures, generic errors, timing equalisation, password policy, scrypt | No breached-password check, no CAPTCHA, no email/SMS recovery flow |
| Sessions | Token theft, replay | 15-min access JWT bound to a revocable session, rotating single-use refresh tokens with reuse detection (kills the session), device list, admin revoke, revoke-on-password-change | Access token valid up to cache TTL (5 s) after revoke; tokens in client storage are the client's job |
| Privileged accounts | Password-only compromise | TOTP MFA enforced for every non-learner role (production default), backup codes, IdP-MFA required for SSO, MFA reset audited | Phishable (TOTP not WebAuthn); privileged session max 12 h |
| SSO | Forged/replayed IdP response | auth-code + PKCE, state single-use, nonce, issuer/audience/signature (JWKS) checks, no auto-provisioning | SAML not implemented; IdP trust is configuration |
| Authorization | Privilege escalation, IDOR | default-deny global guard, per-route roles, owner scoping in queries, 404-not-403 for others' objects, **automated audit of all 202 routes** (every role-restricted route proven to refuse a wrong-role caller; reviewed allow-lists for public and self-scoped routes; committed inventory diff) | Object-level rules are per-handler code, covered by feature tests rather than a central policy engine |
| Admissions inbound | Spoofed enrolment | HMAC over timestamp+raw body, 5-min window, idempotent by external ref | Shared secret rotation process undefined |
| Proctor webhook | Spoofed/ replayed incidents | HMAC + window, event-id dedupe, https-only evidence URLs | Vendor not selected |
| Learner input -> LLM (tutor, grading, curriculum) | Prompt injection, data exfiltration | untrusted-data fencing, tag-spoof neutralisation, schema-constrained output, citation/groundedness/safety gates, injection signals force human review, PII redaction before provider, fallback/kill switch/budget | Reduces but cannot eliminate injection; model providers are third parties (residency, retention) |
| AI grading | Manipulation of scores | evidence must be verbatim in the submission, calibrated confidence, human routing, append-only history, appeals, maker-checker overrides | Golden/benchmark data not yet supplied |
| Untrusted code | Sandbox escape, resource abuse | never executed in-process; adapter with network-off/read-only/no-caps/limited container; disabled by default | Docker adapter **never run live**; needs gVisor/Firecracker-class isolation and a review |
| Uploads | Malware, zip bombs, path traversal | extension allow-list, size caps, owner-scoped keys, archive limits | **Malware scanner is a stub** (launch blocker) |
| Exams | Impersonation, answer leakage, tampering | proctor adapter + identity check, bank segregation, server clock, seeded per-attempt papers, keys never sent, hash-chained logs, receipts, blind adjudication, SoD on release | Client-side signals can be suppressed by a hostile client; no secure browser |
| Offline media | Redistribution | per-asset AES-256-GCM, device-bound RSA-wrapped keys, expiry/revocation | The client must protect the unwrapped key; no DRM |
| Audit / evidence | Tampering by an insider or attacker with DB access | append-only triggers, hash chains (audit, exams), verification endpoint + DR drill | A DB superuser can disable triggers (detected by chain verification, not prevented); anchor hashes externally (e.g., WORM bucket) |
| Secrets | Leakage, weak defaults | production boot guard rejects placeholders/short keys, MFA/rate-limit bypass flags forbidden in production, TOTP seeds encrypted at rest | `OFFLINE_MASTER_KEY`/`DATA_ENC_KEY` are env vars: move to KMS/HSM with rotation |
| Availability | Floods, slow clients | IP + actor limits, body cap, timeouts, connection keep-alive tuning, kill switches, queue backoff | No WAF/DDoS tier (infra), limits are per instance |
| Logs / metrics | PII leakage, cardinality bombs | JSON logs with redaction, no bodies logged, metrics keyed by route template, authenticated `/metrics` | Application log redaction is regex-based |
| Privacy operations | Mass export / erasure by a stolen session | step-up (password or fresh SSO), approval by a different person for erasure/correction, audited | - |
