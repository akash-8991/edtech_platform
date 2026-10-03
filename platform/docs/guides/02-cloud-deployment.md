# Cloud deployment guide (AWS reference, ap-south-1)

> **Status, read first.** Infrastructure as code now exists: **[`infra/terraform`](../../infra/terraform/README.md)** builds everything in this guide (and CloudFront, WAF, alarms and the optional grader host). It is statically checked in CI but **has not been applied to a real AWS account**, and `terraform validate`/`plan` have not yet run (see its README). This document remains the manual, step-by-step reference procedure and explains each piece; prefer the Terraform for a real environment so it is repeatable. Neither has been executed against a real account.
>
> Do not go live on this guide alone: [`../release/gate-evidence.md`](../release/gate-evidence.md) lists what is still missing (penetration test, accessibility audit with people, live-provider validation, scale test on the deployed environment).
---

## 1. Target architecture

```
                         Route 53 ── ACM certificate
                               │
                     ┌─────────▼─────────┐        public subnets
                     │  Application LB   │  HTTPS 443 -> target group (health: /health/ready)
                     └─────────┬─────────┘
 ───────────────────────────────┼──────────────────────────────  private subnets (2 AZs)
        ┌──────────────────────┐│┌──────────────────────┐
        │ ECS service  "api"   ││ │ ECS service "worker" │   Fargate, PROCESS_ROLE=api / worker
        │ 2+ tasks, autoscale  │││ 1+ tasks             │   same image, different command
        └─┬──────┬──────┬──────┘│└─┬──────┬──────┬──────┘
          │      │      │       │  │      │      │
   ┌──────▼─┐ ┌──▼───┐ ┌▼─────┐ │ ┌▼──────────────────┐
   │ RDS    │ │Elasti│ │ S3   │ │ │ ECS service        │  clamd on :3310 (internal only)
   │Postgres│ │Cache │ │ (KMS)│ │ │ "clamav"           │
   │16 MultiAZ│ Redis │ │ media│ │ └────────────────────┘
   └────────┘ └──────┘ └──────┘ │
        Secrets Manager (all secrets) · CloudWatch Logs · (optional) Prometheus/Grafana
```

| Concern | Service | Why / setting |
|---|---|---|
| Container runtime | **ECS on Fargate** | no servers to patch; separate `api` and `worker` services scale independently |
| Database | **RDS PostgreSQL 16**, Multi-AZ, encrypted, automated backups with PITR | the system of record, including tamper-evident audit chains |
| Shared state | **ElastiCache Redis 7** (TLS) | shared rate limits, instant session revocation |
| Files | **S3** (private, versioned, SSE-KMS) | media, submissions, exports; `STORAGE_DRIVER=s3` |
| Malware scanning | **ClamAV (clamd)** as an internal ECS service | `SCANNER=clamav`; uploads fail closed |
| Secrets | **Secrets Manager** | loaded at startup (`SECRETS_MANAGER_SECRET_ID`) |
| Edge | **ALB + ACM + Route 53** | TLS termination, `TRUST_PROXY=1` |
| Logs and metrics | CloudWatch Logs (JSON), `/metrics` scraped by Prometheus (or CloudWatch agent) | alert rules in `platform/ops/prometheus/alerts.yml` |

Region **ap-south-1 (Mumbai)** is assumed for India data residency. Keep database, cache, storage and compute in the same region.

## 2. Before you start

1. An AWS account with admin rights for the set-up, the AWS CLI v2 configured (`aws sts get-caller-identity`), Docker, `jq`, `openssl`.
2. A VPC with **2 private and 2 public subnets** in different AZs, and a NAT gateway for outbound access (AI providers, IdP). If you have none, create one with the AWS-provided VPC wizard or your landing-zone template; the commands below take subnet and security-group IDs as inputs.
3. A domain you control in Route 53 (or DNS you can add records to).
4. Decisions you owe the platform ([`../decision-log.md`](../decision-log.md) open items): identity provider, proctoring vendor, retention schedule, support model.

Set variables once; every later command uses them:

```bash
export AWS_REGION=ap-south-1 AWS_DEFAULT_REGION=ap-south-1
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export APP=edtech ENVN=prod                               # name prefix: edtech-prod-*
export VPC_ID=vpc-xxxxxxxx
export PRIV_SUBNETS="subnet-aaaa,subnet-bbbb"            # private, two AZs
export PUB_SUBNETS="subnet-cccc,subnet-dddd"             # public, two AZs
export DOMAIN=learn.institute.edu                         # public host name
```

## 3. Security groups

```bash
sg() { aws ec2 create-security-group --group-name "$APP-$ENVN-$1" --description "$1" --vpc-id $VPC_ID --query GroupId --output text; }
SG_ALB=$(sg alb); SG_APP=$(sg app); SG_DB=$(sg db); SG_REDIS=$(sg redis); SG_CLAM=$(sg clamav)

aws ec2 authorize-security-group-ingress --group-id $SG_ALB   --protocol tcp --port 443  --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $SG_APP   --protocol tcp --port 3000 --source-group $SG_ALB      # ALB -> api
aws ec2 authorize-security-group-ingress --group-id $SG_DB    --protocol tcp --port 5432 --source-group $SG_APP      # app -> postgres
aws ec2 authorize-security-group-ingress --group-id $SG_REDIS --protocol tcp --port 6379 --source-group $SG_APP      # app -> redis
aws ec2 authorize-security-group-ingress --group-id $SG_CLAM  --protocol tcp --port 3310 --source-group $SG_APP      # app -> clamd
```

Nothing but the load balancer is reachable from the internet.

## 4. Secrets

Generate every secret and key, store them as one JSON secret, and keep a copy in your organisation's password vault (these cannot be recovered from the platform):

```bash
gen() { openssl rand -base64 48 | tr -d '=+/' | cut -c1-48; }
cat > /tmp/secret.json <<EOF
{
  "JWT_SECRET": "$(gen)",
  "ADMISSIONS_HMAC_SECRET": "$(gen)",
  "MEDIA_TOKEN_SECRET": "$(gen)",
  "EXAM_RECEIPT_SECRET": "$(gen)",
  "LAB_QR_SECRET": "$(gen)",
  "METRICS_TOKEN": "$(gen)",
  "DATA_ENC_KEY": "$(openssl rand -hex 32)",
  "OFFLINE_MASTER_KEY": "$(openssl rand -hex 32)"
}
EOF
aws secretsmanager create-secret --name $APP/$ENVN/app --secret-string file:///tmp/secret.json \
  --kms-key-id alias/aws/secretsmanager >/dev/null && shred -u /tmp/secret.json 2>/dev/null || rm -P /tmp/secret.json
```

Add later (when you have them): `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `PROCTOR_API_KEY`, `PROCTOR_WEBHOOK_SECRET`, `OIDC_CLIENT_SECRET`. Update with `aws secretsmanager put-secret-value --secret-id $APP/$ENVN/app --secret-string file://updated.json` (the JSON must contain **all** keys; read the current value first with `get-secret-value`). Rotation procedure per key: [`../security/key-rotation.md`](../security/key-rotation.md). `EXAM_RECEIPT_SECRET` and the two encryption keys must **never** be lost or regenerated casually.

## 5. Data stores

### 5.1 KMS key and S3 bucket

```bash
KMS_KEY_ARN=$(aws kms create-key --description "$APP $ENVN data" --query KeyMetadata.Arn --output text)
aws kms create-alias --alias-name alias/$APP-$ENVN --target-key-id $KMS_KEY_ARN
BUCKET=$ACCOUNT-$APP-$ENVN-media

aws s3api create-bucket --bucket $BUCKET --create-bucket-configuration LocationConstraint=$AWS_REGION
aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket $BUCKET --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket $BUCKET --server-side-encryption-configuration \
  "{\"Rules\":[{\"ApplyServerSideEncryptionByDefault\":{\"SSEAlgorithm\":\"aws:kms\",\"KMSMasterKeyID\":\"$KMS_KEY_ARN\"},\"BucketKeyEnabled\":true}]}"
# deny any non-TLS access
aws s3api put-bucket-policy --bucket $BUCKET --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"TLSOnly\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"arn:aws:s3:::$BUCKET\",\"arn:aws:s3:::$BUCKET/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"
```

Retention rules for exports and submissions come from the institute's retention schedule (open decision); the application also deletes exports after `retention.export_days`.

### 5.2 PostgreSQL (RDS)

```bash
aws rds create-db-subnet-group --db-subnet-group-name $APP-$ENVN --db-subnet-group-description "$APP $ENVN" \
  --subnet-ids $(echo $PRIV_SUBNETS | tr ',' ' ')
DB_PASS=$(openssl rand -base64 32 | tr -d '=+/')
aws rds create-db-instance --db-instance-identifier $APP-$ENVN-db \
  --engine postgres --engine-version 16 --db-instance-class db.m6g.large \
  --allocated-storage 100 --storage-type gp3 --storage-encrypted --kms-key-id $KMS_KEY_ARN \
  --master-username edtech_admin --master-user-password "$DB_PASS" --db-name edtech \
  --multi-az --no-publicly-accessible --db-subnet-group-name $APP-$ENVN --vpc-security-group-ids $SG_DB \
  --backup-retention-period 14 --deletion-protection --enable-performance-insights \
  --copy-tags-to-snapshot
aws rds wait db-instance-available --db-instance-identifier $APP-$ENVN-db
DB_HOST=$(aws rds describe-db-instances --db-instance-identifier $APP-$ENVN-db --query 'DBInstances[0].Endpoint.Address' --output text)
```

Store the connection string in the secret (add `DATABASE_URL` to the JSON from §4): `postgresql://edtech_admin:<DB_PASS>@$DB_HOST:5432/edtech?sslmode=require&connection_limit=10`. Better: create a least-privilege application role and use that for the app, keeping `edtech_admin` for migrations only:

```sql
-- run once as edtech_admin (psql from a bastion or an ECS exec session)
CREATE ROLE edtech_app LOGIN PASSWORD '<generated>';
GRANT CONNECT ON DATABASE edtech TO edtech_app;
GRANT USAGE ON SCHEMA public TO edtech_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO edtech_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO edtech_app;
```

(Run it before the first migration so default privileges apply to the tables the migration creates, **or** run `GRANT ... ON ALL TABLES IN SCHEMA public` after migrating.) Append-only evidence tables are protected by database triggers that block `UPDATE`/`DELETE` for *every* role including the owner, so the role split is defence in depth, not the only control.

Tuning: size the pool so `(api tasks + worker tasks) × connection_limit` stays under 80% of `max_connections` (db.m6g.large allows ≈ 400+). For many tasks put **RDS Proxy** or PgBouncer (transaction mode, `DB_PGBOUNCER=1`) in front; see [`../ops/scaling.md`](../ops/scaling.md). A read replica for reports: `aws rds create-db-instance-read-replica` and set `DATABASE_REPLICA_URL`.

### 5.3 Redis (ElastiCache)

```bash
aws elasticache create-cache-subnet-group --cache-subnet-group-name $APP-$ENVN --cache-subnet-group-description "$APP $ENVN" \
  --subnet-ids $(echo $PRIV_SUBNETS | tr ',' ' ')
aws elasticache create-replication-group --replication-group-id $APP-$ENVN-redis --replication-group-description "$APP $ENVN" \
  --engine redis --engine-version 7.1 --cache-node-type cache.t4g.small --num-cache-clusters 2 --automatic-failover-enabled \
  --cache-subnet-group-name $APP-$ENVN --security-group-ids $SG_REDIS \
  --transit-encryption-enabled --at-rest-encryption-enabled --kms-key-id $KMS_KEY_ARN
aws elasticache wait replication-group-available --replication-group-id $APP-$ENVN-redis
REDIS_HOST=$(aws elasticache describe-replication-groups --replication-group-id $APP-$ENVN-redis --query 'ReplicationGroups[0].PrimaryEndpoint.Address' --output text)
```

`REDIS_URL=rediss://$REDIS_HOST:6379` (note `rediss`, TLS). Add it to the secret JSON.

## 6. Container images

```bash
for r in api api-migrate; do aws ecr create-repository --repository-name $APP-$ENVN/$r --image-scanning-configuration scanOnPush=true >/dev/null; done
ECR=$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com
aws ecr get-login-password | docker login --username AWS --password-stdin $ECR

cd platform/api
TAG=$(git rev-parse --short HEAD)
docker build --platform linux/amd64 --target runtime -t $ECR/$APP-$ENVN/api:$TAG .            # runtime image: no dev tools, non-root
docker build --platform linux/amd64 --target build   -t $ECR/$APP-$ENVN/api-migrate:$TAG .    # build image: includes the Prisma CLI and scripts
docker push $ECR/$APP-$ENVN/api:$TAG && docker push $ECR/$APP-$ENVN/api-migrate:$TAG
```

Why two images: the runtime image deliberately has no migration tooling. The `api-migrate` image is used **only** for one-off tasks (migrations, creating the first admin). Scan results appear in ECR; the CI workflow also runs Trivy.

## 7. IAM roles

```bash
# Trust policy for ECS tasks
cat > /tmp/trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
aws iam create-role --role-name $APP-$ENVN-exec --assume-role-policy-document file:///tmp/trust.json >/dev/null
aws iam attach-role-policy --role-name $APP-$ENVN-exec --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam create-role --role-name $APP-$ENVN-task --assume-role-policy-document file:///tmp/trust.json >/dev/null

SECRET_ARN=$(aws secretsmanager describe-secret --secret-id $APP/$ENVN/app --query ARN --output text)
cat > /tmp/task-policy.json <<EOF
{"Version":"2012-10-17","Statement":[
 {"Sid":"Media","Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:DeleteObject","s3:ListBucket"],
  "Resource":["arn:aws:s3:::$BUCKET","arn:aws:s3:::$BUCKET/*"]},
 {"Sid":"Kms","Effect":"Allow","Action":["kms:GenerateDataKey","kms:Decrypt"],"Resource":"$KMS_KEY_ARN"},
 {"Sid":"Secrets","Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"$SECRET_ARN"}]}
EOF
aws iam put-role-policy --role-name $APP-$ENVN-task --policy-name app --policy-document file:///tmp/task-policy.json
```

The **task** role is what the application uses at runtime (S3, KMS, the one secret): no static AWS keys are set. The **execution** role only lets ECS pull the image and write logs.

## 8. Logs, cluster and task definitions

```bash
aws logs create-log-group --log-group-name /ecs/$APP-$ENVN --retention-in-days 400
aws ecs create-cluster --cluster-name $APP-$ENVN >/dev/null
```

Common environment for the application tasks (no secrets here; they come from Secrets Manager at start-up):

```bash
COMMON_ENV='[
 {"name":"NODE_ENV","value":"production"},
 {"name":"AWS_REGION","value":"'$AWS_REGION'"},
 {"name":"SECRETS_MANAGER_SECRET_ID","value":"'$APP/$ENVN/app'"},
 {"name":"STORAGE_DRIVER","value":"s3"},{"name":"S3_BUCKET","value":"'$BUCKET'"},{"name":"S3_REGION","value":"'$AWS_REGION'"},
 {"name":"S3_KMS_KEY_ID","value":"'$KMS_KEY_ARN'"},
 {"name":"SCANNER","value":"clamav"},{"name":"CLAMD_HOST","value":"clamav.'$APP-$ENVN'.local"},
 {"name":"CORS_ORIGINS","value":"https://'$DOMAIN'"},{"name":"TRUST_PROXY","value":"1"}]'
```

`DATABASE_URL` and `REDIS_URL` live in the secret (§4/§5). Create three task definitions: **api**, **worker**, **migrate** (a one-off). The `td` helper writes one:

```bash
td() { # $1 family  $2 image  $3 PROCESS_ROLE ("" for none)  $4 command-json  $5 port-mappings-json  $6 cpu  $7 memory
cat > /tmp/td-$1.json <<EOF
{"family":"$APP-$ENVN-$1","networkMode":"awsvpc","requiresCompatibilities":["FARGATE"],"cpu":"$6","memory":"$7",
 "runtimePlatform":{"cpuArchitecture":"X86_64","operatingSystemFamily":"LINUX"},
 "executionRoleArn":"arn:aws:iam::$ACCOUNT:role/$APP-$ENVN-exec","taskRoleArn":"arn:aws:iam::$ACCOUNT:role/$APP-$ENVN-task",
 "containerDefinitions":[{"name":"$1","image":"$2","essential":true,"command":$4,"portMappings":$5,
  "environment":$(jq -c --arg r "$3" '. + (if $r=="" then [] else [{"name":"PROCESS_ROLE","value":$r}] end)' <<<"$COMMON_ENV"),
  "logConfiguration":{"logDriver":"awslogs","options":{"awslogs-group":"/ecs/$APP-$ENVN","awslogs-region":"$AWS_REGION","awslogs-stream-prefix":"$1"}}}]}
EOF
aws ecs register-task-definition --cli-input-json file:///tmp/td-$1.json >/dev/null; }

td api     $ECR/$APP-$ENVN/api:$TAG         api    '["node","dist/src/main.js"]'   '[{"containerPort":3000}]' 1024 2048
td worker  $ECR/$APP-$ENVN/api:$TAG         worker '["node","dist/src/worker.js"]' '[]'                       1024 2048
td migrate $ECR/$APP-$ENVN/api-migrate:$TAG ""     '["npx","prisma","migrate","deploy"]' '[]'                 512  1024
```

> **Secrets in the container.** `SECRETS_MANAGER_SECRET_ID` makes the process fetch the secret itself at start-up (using the task role), so `DATABASE_URL`, `REDIS_URL` and keys never appear in task definitions or the console. The `migrate` task needs `DATABASE_URL` too: because the Prisma CLI reads the environment directly (not the secret store), give that one task a `secrets` entry in its container definition instead: `"secrets":[{"name":"DATABASE_URL","valueFrom":"<SECRET_ARN>:DATABASE_URL::"}]` (ECS resolves JSON keys with that syntax; the **execution** role then needs `secretsmanager:GetSecretValue` on the secret).

## 9. ClamAV service (internal)

```bash
aws servicediscovery create-private-dns-namespace --name $APP-$ENVN.local --vpc $VPC_ID >/dev/null   # wait: aws servicediscovery list-operations
NS_ID=$(aws servicediscovery list-namespaces --query "Namespaces[?Name=='$APP-$ENVN.local'].Id" --output text)
SD_ARN=$(aws servicediscovery create-service --name clamav --namespace-id $NS_ID --dns-config 'DnsRecords=[{Type=A,TTL=10}]' --query Service.Arn --output text)

cat > /tmp/td-clamav.json <<EOF
{"family":"$APP-$ENVN-clamav","networkMode":"awsvpc","requiresCompatibilities":["FARGATE"],"cpu":"1024","memory":"3072",
 "executionRoleArn":"arn:aws:iam::$ACCOUNT:role/$APP-$ENVN-exec",
 "containerDefinitions":[{"name":"clamav","image":"clamav/clamav:stable","essential":true,"portMappings":[{"containerPort":3310}],
  "logConfiguration":{"logDriver":"awslogs","options":{"awslogs-group":"/ecs/$APP-$ENVN","awslogs-region":"$AWS_REGION","awslogs-stream-prefix":"clamav"}}}]}
EOF
aws ecs register-task-definition --cli-input-json file:///tmp/td-clamav.json >/dev/null
aws ecs create-service --cluster $APP-$ENVN --service-name clamav --task-definition $APP-$ENVN-clamav --desired-count 2 --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNETS],securityGroups=[$SG_CLAM],assignPublicIp=DISABLED}" \
  --service-registries registryArn=$SD_ARN >/dev/null
```

ClamAV needs outbound internet (via NAT) to download signatures on start and takes a couple of minutes to become ready. Mirror the image into ECR and pin a digest before production. Files above `SCAN_MAX_BYTES` (25 MB) are not scanned inline; see D-078 in the decision log.

## 10. Load balancer, DNS, TLS

```bash
CERT_ARN=$(aws acm request-certificate --domain-name $DOMAIN --validation-method DNS --query CertificateArn --output text)
# create the CNAME that ACM prints (aws acm describe-certificate --certificate-arn $CERT_ARN) in your DNS, then:
aws acm wait certificate-validated --certificate-arn $CERT_ARN

ALB_ARN=$(aws elbv2 create-load-balancer --name $APP-$ENVN --subnets $(echo $PUB_SUBNETS | tr ',' ' ') --security-groups $SG_ALB --scheme internet-facing --query 'LoadBalancers[0].LoadBalancerArn' --output text)
TG_ARN=$(aws elbv2 create-target-group --name $APP-$ENVN-api --protocol HTTP --port 3000 --vpc-id $VPC_ID --target-type ip \
  --health-check-path /health/ready --health-check-interval-seconds 15 --healthy-threshold-count 2 --unhealthy-threshold-count 3 --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 create-listener --load-balancer-arn $ALB_ARN --protocol HTTPS --port 443 --certificates CertificateArn=$CERT_ARN \
  --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 --default-actions Type=forward,TargetGroupArn=$TG_ARN >/dev/null
aws elbv2 modify-load-balancer-attributes --load-balancer-arn $ALB_ARN --attributes Key=idle_timeout.timeout_seconds,Value=120 Key=routing.http.drop_invalid_header_fields.enabled,Value=true
aws elbv2 modify-target-group-attributes --target-group-arn $TG_ARN --attributes Key=deregistration_delay.timeout_seconds,Value=30
```

Point `$DOMAIN` at the ALB with an alias record in Route 53. Do **not** expose `/metrics` publicly: add an ALB listener rule returning 403 for path `/metrics` (scrape it from inside the VPC with the bearer token).

## 11. First deployment

### 11.1 Migrate the database (one-off task)

```bash
NET="awsvpcConfiguration={subnets=[$PRIV_SUBNETS],securityGroups=[$SG_APP],assignPublicIp=DISABLED}"
TASK=$(aws ecs run-task --cluster $APP-$ENVN --launch-type FARGATE --task-definition $APP-$ENVN-migrate --network-configuration "$NET" --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster $APP-$ENVN --tasks $TASK
aws ecs describe-tasks --cluster $APP-$ENVN --tasks $TASK --query 'tasks[0].containers[0].exitCode'     # must print 0
aws logs tail /ecs/$APP-$ENVN --since 10m | grep -i "migration"                                          # "All migrations have been successfully applied"
```

This is the **only** place the schema changes. Never run it from the API container. Always run it *before* rolling out a new image, and see [`../ops/migrations.md`](../ops/migrations.md) for the expand/contract rules that make rollbacks safe.

### 11.2 Start the services

```bash
aws ecs create-service --cluster $APP-$ENVN --service-name api --task-definition $APP-$ENVN-api --desired-count 2 --launch-type FARGATE \
  --network-configuration "$NET" --load-balancers targetGroupArn=$TG_ARN,containerName=api,containerPort=3000 \
  --health-check-grace-period-seconds 60 --deployment-configuration "minimumHealthyPercent=100,maximumPercent=200,deploymentCircuitBreaker={enable=true,rollback=true}" >/dev/null
aws ecs create-service --cluster $APP-$ENVN --service-name worker --task-definition $APP-$ENVN-worker --desired-count 1 --launch-type FARGATE \
  --network-configuration "$NET" >/dev/null
aws ecs wait services-stable --cluster $APP-$ENVN --services api worker clamav
curl -s https://$DOMAIN/health/ready        # {"status":"ready"}
```

If a task keeps restarting, read why: `aws logs tail /ecs/$APP-$ENVN --since 15m`. The usual cause is the production configuration guard printing `Refusing to start: unsafe production configuration` with the exact fix.

### 11.3 Create the first administrator and enrol MFA

There is no seeded user in production. Create the owner account with a one-off task (a strong passphrase, passed through the environment so it never appears in a command history):

```bash
aws ecs run-task --cluster $APP-$ENVN --launch-type FARGATE --task-definition $APP-$ENVN-migrate --network-configuration "$NET" \
  --overrides '{"containerOverrides":[{"name":"migrate","command":["npx","ts-node","scripts/create-user.ts","--email","you@institute.edu","--name","Your Name","--roles","SUPER_ADMIN,PLATFORM_ADMIN"],"environment":[{"name":"USER_PASSWORD","value":"<a long passphrase>"}]}]}'
```

Then sign in. Because production **enforces MFA** for staff, the first login returns `mfaEnrollmentRequired`; enrol your authenticator app and **store the 10 backup codes** (shown once), following [the user guide §2.3](03-user-guide.md#23-multi-factor-authentication-staff-tested):

```bash
curl -s -X POST https://$DOMAIN/v1/auth/login -H 'Content-Type: application/json' -d '{"email":"you@institute.edu","password":"<passphrase>"}'
# -> {"mfaEnrollmentRequired":true,"enrollmentToken":"..."}  then /v1/auth/mfa/enroll/start and /confirm
```

From there create other staff the same way, and let the admissions flow create learners.

### 11.4 Smoke test

```bash
BASE=https://$DOMAIN
curl -s $BASE/health/ready
curl -s -o /dev/null -w "%{http_code}\n" $BASE/metrics                      # 403/404 from the ALB rule, never 200
curl -sI $BASE/health | grep -iE "strict-transport|x-frame|content-security"  # hardened headers present
```

The seeded-user walkthrough script is **development only**; do not run it against production (it needs synthetic users).

## 12. Operating it

| Task | How |
|---|---|
| Deploy a new version | build and push images with a new `TAG` (§6) → run the `migrate` task (§11.1) → `td ...` new revisions → `aws ecs update-service --cluster $APP-$ENVN --service api --task-definition $APP-$ENVN-api` (and `worker`). The circuit breaker rolls back a failing deployment. |
| Scale | `aws ecs update-service ... --desired-count N`, or add Application Auto Scaling on CPU/ALB request count for `api`. Workers are safe at N > 1. Re-check connection budget (§5.2). |
| Logs | `aws logs tail /ecs/$APP-$ENVN --follow`; JSON lines carry `traceId`, `cid`; filter with `--filter-pattern '{ $.level = "error" }'`. |
| Metrics and alerts | scrape `/metrics` (bearer `METRICS_TOKEN`) with Prometheus; load `platform/ops/prometheus/alerts.yml` and `platform/ops/grafana/edtech-overview.json`. Runbooks: [`../ops/runbooks.md`](../ops/runbooks.md), SLOs: [`../ops/slo-and-alerts.md`](../ops/slo-and-alerts.md). |
| Backups | RDS automated backups + PITR (14 days) and snapshots before each release: `aws rds create-db-snapshot --db-instance-identifier $APP-$ENVN-db --db-snapshot-identifier pre-$TAG`. S3 versioning is on. |
| Restore drill | follow [`../ops/dr-plan.md`](../ops/dr-plan.md): restore to a scratch instance, then run `GET /v1/ops/integrity` against it; a successful drill proves audit chains survived. **Schedule one before go-live; the cloud drill has not been done.** |
| Rotate keys | [`../security/key-rotation.md`](../security/key-rotation.md) |
| Costs (rough, ap-south-1, pilot size) | RDS Multi-AZ m6g.large ≈ US$250/mo, ElastiCache 2 × t4g.small ≈ US$60, Fargate (2 api + 1 worker + 2 clamav) ≈ US$180, ALB ≈ US$25, NAT ≈ US$40 + data, S3/KMS/Secrets small. Use the AWS pricing calculator for your volumes; AI usage is separate and capped by `ai.daily_budget_usd`. |

## 13. Production checklist (tick before real users)

- [ ] `NODE_ENV=production`, `PROCESS_ROLE` set (api/worker), the guard passes (no "Refusing to start")
- [ ] All secrets random and stored only in Secrets Manager; backup copy in the institute's vault
- [ ] RDS Multi-AZ, encrypted, PITR on, deletion protection on; snapshot taken
- [ ] Redis TLS; S3 private, versioned, KMS, TLS-only; no public subnets for data stores
- [ ] ClamAV healthy; test upload of the EICAR test file is **rejected** (use the standard EICAR string in a `.txt`)
- [ ] `/metrics` not reachable from the internet; alerts loaded and a test alert delivered
- [ ] MFA enrolled for every staff account; first admin's backup codes stored
- [ ] CORS lists only your real front-end origins; `TRUST_PROXY=1` verified (client IP in access logs is the user's, not the ALB's)
- [ ] Integrity check green (`/v1/ops/integrity`), `integrity_ok == 1`
- [ ] A restore drill from backup completed and verified in a scratch environment
- [ ] Open decisions closed or accepted: identity provider, proctoring vendor, retention schedule, support model, pilot cohort
- [ ] Independent penetration test done; no critical/high findings open; accessibility audit done on the real client
- [ ] Load test at the expected concurrency on staging (the 50,000-learner target has **not** been tested)

## 14. Other clouds

The design is portable: only the object-store, secret-store, and scanner adapters are cloud-specific, and the object store speaks the S3 API.

| Component | AWS (above) | Azure | Google Cloud |
|---|---|---|---|
| Containers | ECS Fargate | Azure Container Apps (or AKS) | Cloud Run (or GKE) |
| PostgreSQL 16 | RDS Multi-AZ | Azure Database for PostgreSQL Flexible Server (zone-redundant) | Cloud SQL (HA) |
| Redis | ElastiCache | Azure Cache for Redis | Memorystore |
| Files | S3 + KMS | Blob Storage via an S3-compatible gateway (e.g. MinIO gateway), **or** add a Blob driver | GCS with **interoperability (HMAC) keys** and `S3_ENDPOINT=https://storage.googleapis.com` |
| Secrets | Secrets Manager (built in) | Key Vault: **needs a small loader** (`platform/secrets.ts` implements only AWS); or inject as environment variables | Secret Manager: same, or env injection |
| Scanner | clamd on ECS | clamd container app | clamd on Cloud Run/GKE |

Where a built-in adapter is missing, inject the secrets as environment variables from the platform's own secret mechanism (the application reads plain environment variables when `SECRETS_MANAGER_SECRET_ID` is unset). Everything else (guard, health endpoints, metrics, worker split) is identical.

## 15. Kubernetes (alternative to ECS)

Two Deployments from the same image (`command: ["node","dist/src/main.js"]` with `PROCESS_ROLE=api`; `["node","dist/src/worker.js"]` with `PROCESS_ROLE=worker`), a Service + Ingress for the API, readiness probe `GET /health/ready`, liveness `GET /health`, worker probe `GET :3001/health`, a Job for `npx prisma migrate deploy` (migrate image) run before each rollout (Helm pre-upgrade hook or Argo CD pre-sync), `securityContext.runAsNonRoot` (the image already runs as `node`), resource requests of 1 vCPU / 2 GiB per pod as a starting point, and secrets via External Secrets or the CSI Secrets Store driver into environment variables.

## 16. Tear-down (non-production rehearsal)

Delete in reverse order: ECS services (scale to 0 first) → cluster → ALB/target group/listener → RDS (`--skip-final-snapshot` only in a rehearsal; remove deletion protection first) → ElastiCache → S3 (empty the bucket and its versions) → ECR repos → secret (`--force-delete-without-recovery` only in a rehearsal) → KMS key (scheduled deletion) → security groups → IAM roles. Never do this in production without a verified backup.
