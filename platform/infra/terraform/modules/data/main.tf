# Everything that holds state: KMS key, media bucket, PostgreSQL, Redis, and the one secret the application reads at start-up.

data "aws_caller_identity" "me" {}

locals {
  prefix = "${var.name}-${var.environment}"
  prod   = var.environment == "prod"
}

# ---- encryption key ----------------------------------------------------------------------------------------------------------------------------------
resource "aws_kms_key" "data" {
  description             = "${local.prefix} data (RDS, S3, Redis, secrets)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.prefix}"
  target_key_id = aws_kms_key.data.key_id
}

# ---- security groups ---------------------------------------------------------------------------------------------------------------------------------
resource "aws_security_group" "db" {
  name        = "${local.prefix}-db"
  description = "PostgreSQL: reachable from the application only"
  vpc_id      = var.vpc_id
}

resource "aws_security_group" "redis" {
  name        = "${local.prefix}-redis"
  description = "Redis: reachable from the application only"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = var.app_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_app" {
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = var.app_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

# ---- media bucket ------------------------------------------------------------------------------------------------------------------------------------
resource "aws_s3_bucket" "media" {
  bucket        = "${data.aws_caller_identity.me.account_id}-${local.prefix}-media"
  force_destroy = !local.prod
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
  }
}

# Old versions of overwritten files expire; incomplete uploads are cleaned up. Retention of the content itself follows the institute's schedule (the application deletes expired exports).
resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 90 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

data "aws_iam_policy_document" "media" {
  statement {
    sid       = "TLSOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.media.arn, "${aws_s3_bucket.media.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  # The platform's own rule: every upload is SSE-KMS (the application sends the header; a client that does not is refused).
  statement {
    sid       = "RequireKmsOnPut"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.media.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket     = aws_s3_bucket.media.id
  policy     = data.aws_iam_policy_document.media.json
  depends_on = [aws_s3_bucket_public_access_block.media]
}

# ---- PostgreSQL --------------------------------------------------------------------------------------------------------------------------------------
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = local.prefix
  subnet_ids = var.private_subnet_ids
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${local.prefix}-pg16"
  family = "postgres16"
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "this" {
  identifier                          = "${local.prefix}-db"
  engine                              = "postgres"
  engine_version                      = "16"
  instance_class                      = var.db_instance_class
  allocated_storage                   = var.db_allocated_storage
  max_allocated_storage               = var.db_max_allocated_storage
  storage_type                        = "gp3"
  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.data.arn
  db_name                             = "edtech"
  username                            = "edtech_admin"
  password                            = random_password.db.result
  multi_az                            = local.prod
  db_subnet_group_name                = aws_db_subnet_group.this.name
  vpc_security_group_ids              = [aws_security_group.db.id]
  publicly_accessible                 = false
  parameter_group_name                = aws_db_parameter_group.pg16.name
  backup_retention_period             = local.prod ? 14 : 3
  backup_window                       = "20:30-21:30" # 02:00-03:00 IST
  maintenance_window                  = "sun:21:30-sun:22:30"
  copy_tags_to_snapshot               = true
  deletion_protection                 = local.prod
  skip_final_snapshot                 = !local.prod
  final_snapshot_identifier           = local.prod ? "${local.prefix}-final" : null
  performance_insights_enabled        = true
  performance_insights_kms_key_id     = aws_kms_key.data.arn
  auto_minor_version_upgrade          = true
  enabled_cloudwatch_logs_exports     = ["postgresql", "upgrade"]
  monitoring_interval                 = 60
  monitoring_role_arn                 = aws_iam_role.rds_monitoring.arn
  apply_immediately                   = !local.prod
  iam_database_authentication_enabled = false
  ca_cert_identifier                  = "rds-ca-rsa2048-g1"
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${local.prefix}-rds-monitoring"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "monitoring.rds.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# ---- Redis -------------------------------------------------------------------------------------------------------------------------------------------
resource "random_password" "redis" {
  length  = 40
  special = false
}

resource "aws_elasticache_subnet_group" "this" {
  name       = local.prefix
  subnet_ids = var.private_subnet_ids
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = "${local.prefix}-redis"
  description                = "${local.prefix} shared rate limits and session revocation"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = local.prod ? 2 : 1
  automatic_failover_enabled = local.prod
  multi_az_enabled           = local.prod
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result
  snapshot_retention_limit   = local.prod ? 3 : 0
  apply_immediately          = !local.prod
}

# ---- the application secret (read by the process at start-up; see api/src/platform/secrets.ts) --------------------------------------------------------
resource "random_password" "key" {
  for_each = toset(["JWT_SECRET", "ADMISSIONS_HMAC_SECRET", "MEDIA_TOKEN_SECRET", "EXAM_RECEIPT_SECRET", "LAB_QR_SECRET", "METRICS_TOKEN"])
  length   = 48
  special  = false
}

resource "random_id" "hex" {
  for_each    = toset(["DATA_ENC_KEY", "OFFLINE_MASTER_KEY"])
  byte_length = 32
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${var.name}/${var.environment}/app"
  description             = "Application secrets for ${local.prefix}. Add provider keys (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, PROCTOR_*, OIDC_CLIENT_SECRET, VAPID_*, FCM_SERVICE_ACCOUNT) with put-secret-value; Terraform will not overwrite them."
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = local.prod ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode(merge(
    { for k, v in random_password.key : k => v.result },
    { for k, v in random_id.hex : k => v.hex },
    {
      DATABASE_URL = "postgresql://edtech_admin:${random_password.db.result}@${aws_db_instance.this.address}:5432/edtech?sslmode=require&connection_limit=10"
      REDIS_URL    = "rediss://:${random_password.redis.result}@${aws_elasticache_replication_group.this.primary_endpoint_address}:6379"
    }
  ))

  # Once created, people add provider keys and rotate values by hand; a later `terraform apply` must not undo that.
  lifecycle {
    ignore_changes = [secret_string]
  }
}
