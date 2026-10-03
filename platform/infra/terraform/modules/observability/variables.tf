variable "name" { type = string }
variable "environment" { type = string }
variable "alarm_email" { type = string }
variable "alb_arn_suffix" { type = string }
variable "target_group_arn_suffix" { type = string }
variable "cluster_name" { type = string }
variable "api_service_name" { type = string }
variable "worker_service_name" { type = string }
variable "db_identifier" { type = string }
variable "redis_replication_group_id" { type = string }
variable "log_group_name" { type = string }
variable "db_connection_alarm" {
  type    = number
  default = 300
}
