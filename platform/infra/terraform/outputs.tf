output "site_url" {
  value = "https://${var.domain_name}"
}

output "ecr_repositories" {
  description = "Push the api, worker, api-migrate and grader images here (tag = image_tag)."
  value       = module.app.ecr_repositories
}

output "web_bucket" {
  description = "Upload the built web app (platform/web/dist) here, then invalidate the distribution."
  value       = module.web.bucket
}

output "cloudfront_distribution_id" {
  value = module.web.distribution_id
}

output "cluster_name" {
  value = module.app.cluster_name
}

output "migrate_task_definition" {
  description = "Run this one-off task before every new version takes traffic."
  value       = module.app.migrate_task_definition
}

output "private_subnet_ids" {
  value = module.network.private_subnet_ids
}

output "app_security_group_id" {
  value = module.network.app_security_group_id
}

output "app_secret_name" {
  description = "Add provider keys here with `aws secretsmanager put-secret-value` (merge into the existing JSON)."
  value       = module.data.secret_name
}

output "dns_records_to_create" {
  description = "Only when hosted_zone_id is empty: create these records at your DNS provider."
  value = var.hosted_zone_id != "" ? null : {
    site_certificate_validation   = module.web.site_certificate_validation_records
    origin_certificate_validation = module.app.origin_certificate_validation_records
    site_cname                    = { name = var.domain_name, type = "CNAME", value = module.web.distribution_domain }
    origin_cname                  = { name = module.app.origin_domain, type = "CNAME", value = module.app.alb_dns_name }
  }
}
