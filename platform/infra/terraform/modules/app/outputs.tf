output "cluster_name" { value = aws_ecs_cluster.this.name }
output "alb_dns_name" { value = aws_lb.this.dns_name }
output "alb_zone_id" { value = aws_lb.this.zone_id }
output "alb_arn_suffix" { value = aws_lb.this.arn_suffix }
output "target_group_arn_suffix" { value = aws_lb_target_group.api.arn_suffix }
output "origin_domain" { value = local.origin_domain }
output "ecr_repositories" { value = { for k, r in aws_ecr_repository.this : k => r.repository_url } }
output "api_service_name" { value = aws_ecs_service.api.name }
output "worker_service_name" { value = aws_ecs_service.worker.name }
output "migrate_task_definition" { value = aws_ecs_task_definition.migrate.family }
output "origin_certificate_validation_records" {
  description = "Create these CNAMEs in your DNS if hosted_zone_id was left empty."
  value       = [for o in aws_acm_certificate.origin.domain_validation_options : { name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value }]
}
output "log_group_name" { value = aws_cloudwatch_log_group.app.name }
