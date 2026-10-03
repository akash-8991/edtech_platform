variable "name" { type = string }
variable "environment" { type = string }
variable "region" { type = string }
variable "vpc_cidr" { type = string }
variable "az_count" {
  type    = number
  default = 2
}
variable "single_nat_gateway" { type = bool }
variable "log_retention_days" { type = number }
