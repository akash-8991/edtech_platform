variable "name" { type = string }
variable "environment" { type = string }
variable "domain_name" { type = string }
variable "origin_domain" { type = string }
variable "hosted_zone_id" { type = string }
variable "enable_waf" { type = bool }
variable "waf_rate_limit_per_5min" { type = number }
