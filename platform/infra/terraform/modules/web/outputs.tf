output "bucket" { value = aws_s3_bucket.web.bucket }
output "distribution_id" { value = aws_cloudfront_distribution.site.id }
output "distribution_domain" { value = aws_cloudfront_distribution.site.domain_name }
output "site_certificate_validation_records" {
  description = "Create these CNAMEs in your DNS if hosted_zone_id was left empty."
  value       = [for o in aws_acm_certificate.site.domain_validation_options : { name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value }]
}
