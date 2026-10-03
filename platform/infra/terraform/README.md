# Infrastructure as code (Terraform, AWS ap-south-1)

Builds the production topology in `docs/guides/02-cloud-deployment.md` from code, so it can be reviewed, repeated and rebuilt:

```
Route 53 ─► CloudFront (WAF, security headers) ──► S3 web bucket        (the web app; /assets cached a year, index.html and sw.js revalidated)
                         └── /v1/*, /health* ──► ALB (only CloudFront can reach it) ─► ECS Fargate "api"  (autoscaled on CPU and requests per task)
private subnets, 2+ zones                                            ECS Fargate "worker" (ffmpeg, jobs, sweeps, push)   ECS "clamav" (internal)
                                                                     EC2 "grader" host (optional): grader worker + Docker socket proxy
RDS PostgreSQL 16 (Multi-AZ, PITR)   ElastiCache Redis 7 (TLS, auth)   S3 media (SSE-KMS, versioned)   Secrets Manager   KMS   CloudWatch alarms → SNS
```

| Module | Holds |
|---|---|
| `modules/network` | VPC, public/private subnets, NAT, S3 endpoint, flow logs, the security groups (ALB: HTTPS from CloudFront's prefix list only; app, ClamAV) |
| `modules/data` | KMS key, media bucket (TLS-only, SSE-KMS required), RDS, Redis, the application secret (generated keys + DB/Redis URLs; provider keys are added by hand and never overwritten) |
| `modules/app` | ECR (immutable tags, scan on push), cluster, IAM (task role = S3 + KMS + one secret; no static keys), task definitions, services, autoscaling, ALB + origin certificate, optional grader host |
| `modules/web` | S3 web bucket, CloudFront, response-headers policy (CSP, HSTS, `Permissions-Policy: camera=(self)`), WAF (managed rules + per-IP rate limit), DNS aliases |
| `modules/observability` | SNS + e-mail, alarms for 5xx, p95 latency, unhealthy targets, API CPU/memory, worker down, DB CPU/storage/connections/memory, Redis CPU, application error rate |

## Status: written and statically checked, never applied

* `terraform fmt -check` passes and `scripts/check-references.py` (every variable, resource reference, module input and output resolves) passes; both run in CI.
* **`terraform validate` and `terraform plan` have NOT been run** (the provider could not be downloaded on the build machine), and **nothing has ever been applied to a real AWS account.** CI runs `terraform init -backend=false && terraform validate` on every push, which is the first real check: expect to fix some provider-attribute mistakes the static check cannot see. Treat the first `plan` in a scratch account as part of acceptance, then staging before prod.
* The Dockerfile targets `worker` (adds ffmpeg) and `grader` (adds the Docker CLI) were written but not built here.

## First apply (order matters)

1. **State bucket** (once, by hand): an encrypted, versioned S3 bucket and a DynamoDB lock table; uncomment the `backend "s3"` block in `versions.tf`.
2. `cp environments/staging.tfvars.example environments/staging.tfvars` and fill it in (domain, alarm e-mail, sizes).
3. Create the registries first, because services cannot start without images:
   `terraform init && terraform apply -var-file=environments/staging.tfvars -target=module.app.aws_ecr_repository.this`
4. Build and push the images (tag = `image_tag`; use the git commit): from `platform/api`, `docker build --platform linux/amd64 --target runtime -t <ecr>/api:<tag> .`, then targets `worker`, `grader`, and `build` (pushed as `api-migrate`).
5. `terraform apply -var-file=environments/staging.tfvars -var image_tag=<tag>`. If `hosted_zone_id` is empty, certificate validation waits until you create the DNS records printed by `terraform output dns_records_to_create`.
6. **Migrate the database** with the one-off task (`terraform output migrate_task_definition`): `aws ecs run-task --cluster <cluster> --launch-type FARGATE --task-definition <family> --network-configuration "awsvpcConfiguration={subnets=[<private>],securityGroups=[<app sg>],assignPublicIp=DISABLED}"`, wait for exit code 0. The migrations create the audit triggers; apply `prisma/sql/*` as the deployment guide says.
7. **Create the first administrator** with the same task (`npm run user:create`) and sign in.
8. **Upload the web app**: `VITE_API_URL= npm run build` in `platform/web` (empty: same domain), `aws s3 sync dist/ s3://<web bucket> --delete`, then `aws cloudfront create-invalidation --distribution-id <id> --paths '/*'`.
9. **Add provider keys** to the secret (merge into the JSON, do not replace it): `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `PROCTOR_*`, `OIDC_*`, and for push `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` (from `npx web-push generate-vapid-keys`) and `FCM_SERVICE_ACCOUNT` (Firebase service-account JSON). Then set `push_mode = "live"` and apply. Restart the services so they re-read the secret.
10. Run the checks in `docs/release/gate-evidence.md` against this environment (load, restore, pen test) before real learners.

## Choices worth knowing

* **One public name.** The web app and the API share `domain_name`; CloudFront sends `/v1/*` to the ALB at `origin.<domain_name>`. So the browser needs no CORS and the WAF covers both. `TRUST_PROXY=2` (CloudFront, then the ALB) makes client IPs real for rate limiting. The ALB's security group admits only CloudFront.
* **Uploads and WAF.** Lesson, evidence and assignment uploads are raw bytes; the managed rule that caps body size is switched to *count* so they are not refused. The API enforces size limits and scans every file (ClamAV).
* **Grader host.** The code-grading sandbox needs Docker, which Fargate lacks. `enable_grader = true` adds one small EC2 host that runs only the grader worker (`WORKER_JOB_KINDS=GRADE_SUBMISSION`, no sweeps); the worker never touches the Docker socket: a socket proxy allows create/start/attach/wait/remove of containers and nothing else (no exec, images, volumes or networks), IMDSv2 only with hop limit 1, and the sandbox image is pre-pulled by digest. The general worker never claims grading jobs. Learner code runs with `--network none`, read-only root, no capabilities, 64 processes, 256 MB, 0.5 CPU (tested against real Docker: `test/sandbox-live.spec.ts`).
* **Costs you control.** `single_nat_gateway`, `db_multi_az` (prod only), Redis nodes, task counts. Staging example is the cheap profile.
* **Deletion safety.** Production: RDS deletion protection and a final snapshot, ALB deletion protection, buckets are not force-destroyed, 30-day KMS and secret recovery windows.
* **Secrets.** The generated application secret has `ignore_changes` on its value: Terraform creates it once; people add provider keys and rotate by hand. The database URL in it uses the admin user. Before go-live create the least-privilege `edtech_app` role described in the deployment guide and put its URL in the secret.
* **Not included (decide with the institute):** a cross-region backup copy / disaster-recovery region, RDS Proxy or PgBouncer, a bastion or SSM access path for `psql`, CloudFront access logs, AWS Config and GuardDuty, the CI/CD role (GitHub OIDC) that would run migrations and deploys.
