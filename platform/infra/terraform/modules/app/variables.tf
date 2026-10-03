variable "name" { type = string }
variable "environment" { type = string }
variable "region" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "private_subnet_ids" { type = list(string) }
variable "alb_security_group_id" { type = string }
variable "app_security_group_id" { type = string }
variable "clamav_security_group_id" { type = string }
variable "kms_key_arn" { type = string }
variable "media_bucket" { type = string }
variable "media_bucket_arn" { type = string }
variable "secret_arn" { type = string }
variable "secret_name" { type = string }
variable "domain_name" { type = string }
variable "hosted_zone_id" { type = string }
variable "image_tag" { type = string }
variable "api_cpu" { type = number }
variable "api_memory" { type = number }
variable "api_min_tasks" { type = number }
variable "api_max_tasks" { type = number }
variable "worker_cpu" { type = number }
variable "worker_memory" { type = number }
variable "worker_tasks" { type = number }
variable "extra_cors_origins" { type = list(string) }
variable "push_mode" { type = string }
variable "log_retention_days" { type = number }
variable "enable_grader" { type = bool }
variable "grader_instance_type" { type = string }
variable "sandbox_image_python" { type = string }
variable "clamav_image" {
  description = "ClamAV image. Mirror it into your own registry and pin a digest before production."
  type        = string
  default     = "clamav/clamav:stable"
}
variable "docker_socket_proxy_image" {
  description = "Docker socket proxy for the grader host. Mirror it into your own registry and pin a digest before production."
  type        = string
  default     = "tecnativa/docker-socket-proxy:0.2.0"
}
variable "vpc_cidr" { type = string }
