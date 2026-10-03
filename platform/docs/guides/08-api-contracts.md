# API contracts: OpenAPI request and response schemas

`docs/openapi.json` (OpenAPI 3.1) describes **every route**: its path and query parameters, who may call it, the request body (with required fields), and the response bodies. It is also served, to platform staff, at `GET /v1/openapi.json`. Import it into Postman, Insomnia, a client generator or a gateway.

## Where the schemas come from, and why you can trust them

* **Routes, roles, rate limits** are read from the running application (`src/platform/inventory.ts`).
* **Request fields**: class-validator rules for DTO-typed bodies, the `need(...)` checks for the rest (these are the *required* fields), and every field the handler reads.
* **Response shapes** are inferred from what the API actually returns while the test suite runs (`OPENAPI_RECORD=file npx jest`, then `npm run contracts:infer`). "Required" means present in every sample; id-keyed objects become maps; timestamps and ids get formats. The result is committed as `src/platform/contracts/inferred.json`.
* **Human facts** (summaries, tags, raw-upload routes, binary responses, webhook headers) live in `src/platform/contracts/manual.ts`.
* **Enforced, not just documented:** in tests every successful response, and the request that produced it, is validated against its contract (`CONTRACT_ENFORCE=1`, on by default in `test/setup-env.ts`). A handler that drifts from its schema fails the suite with the exact field. `test/openapi.spec.ts` also fails if a route has no summary, no success response, or the committed `docs/openapi.json` is stale. 224 of 229 operations have observed responses from the tests; the other 5 are binary or self-describing and declared by hand.

Honest limits: because response schemas describe observed behaviour, a field that is optional but was always present in the tests shows as required, and an enum is shown as a string. A route's rare responses (for example a field only present for one role) are only as good as the tests that exercise them. Error bodies are documented generically (`Error`, `ValidationError`).

## Workflow when you change the API

```bash
npm test                         # fails with the exact field if a response or request drifted
OPENAPI_RECORD=/tmp/s.jsonl CONTRACT_ENFORCE=0 npx jest      # only after an intentional change: record fresh traffic
SAMPLES=/tmp/s.jsonl npm run contracts:infer                  # redraft inferred.json (review the diff)
npm run inventory && npm run openapi                          # regenerate docs/api-inventory.json, api-reference.md, openapi.json
```

New route? Add a one-line summary to `manual.ts` (the test tells you), write a test that calls it (so the contract is inferred from a real response), then run the steps above.
