output "kms_key_arn" { value = aws_kms_key.data.arn }
output "media_bucket" { value = aws_s3_bucket.media.bucket }
output "media_bucket_arn" { value = aws_s3_bucket.media.arn }
output "secret_arn" { value = aws_secretsmanager_secret.app.arn }
output "secret_name" { value = aws_secretsmanager_secret.app.name }
output "db_identifier" { value = aws_db_instance.this.identifier }
output "db_address" { value = aws_db_instance.this.address }
output "redis_replication_group_id" { value = aws_elasticache_replication_group.this.replication_group_id }
