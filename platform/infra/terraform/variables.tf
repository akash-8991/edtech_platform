variable "name" {
  description = "Name prefix for every resource."
  type        = string
  default     = "edtech"
}

variable "environment" {
  description = "staging or prod. Production turns on deletion protection and Multi-AZ."
  type        = string
  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "region" {
  description = "AWS region. ap-south-1 (Mumbai) keeps data in India."
  type        = string
  default     = "ap-south-1"
}

variable "domain_name" {
  description = "Public host name, for example learn.institute.edu. The web app and the API share it (the API is under /v1)."
  type        = string
}

variable "hosted_zone_id" {
  description = "Route 53 hosted zone that holds domain_name. Leave empty if DNS is elsewhere: the certificate validation records and the alias are then printed as outputs for you to create."
  type        = string
  default     = ""
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "single_nat_gateway" {
  description = "One NAT gateway instead of one per zone: cheaper, but a zone failure then cuts outbound access. Use true for staging only."
  type        = bool
  default     = false
}

variable "image_tag" {
  description = "Tag of the api / worker images in ECR to deploy (the git commit)."
  type        = string
  default     = "bootstrap"
}

# ---- sizing -----------------------------------------------------------------------------------------------------------------------------------------
variable "db_instance_class" {
  type    = string
  default = "db.m6g.large"
}

variable "db_allocated_storage" {
  type    = number
  default = 100
}

variable "db_max_allocated_storage" {
  description = "Storage autoscaling ceiling (GB)."
  type        = number
  default     = 500
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "api_cpu" {
  type    = number
  default = 1024
}

variable "api_memory" {
  type    = number
  default = 2048
}

variable "api_min_tasks" {
  type    = number
  default = 2
}

variable "api_max_tasks" {
  type    = number
  default = 12
}

variable "worker_cpu" {
  description = "The worker also runs ffmpeg for adaptive video: give it CPU."
  type        = number
  default     = 2048
}

variable "worker_memory" {
  type    = number
  default = 4096
}

variable "worker_tasks" {
  type    = number
  default = 1
}

variable "enable_grader" {
  description = "Run the code-grading sandbox. Fargate cannot run Docker, so this adds a small EC2 capacity provider that hosts the grader worker. Leave false until the sandbox is wanted."
  type        = bool
  default     = false
}

variable "grader_instance_type" {
  type    = string
  default = "t3.medium"
}

variable "sandbox_image_python" {
  description = "Python sandbox image, pinned by digest, for example python@sha256:... (required when enable_grader is true)."
  type        = string
  default     = ""
}

# ---- behaviour ---------------------------------------------------------------------------------------------------------------------------------------
variable "extra_cors_origins" {
  description = "Further browser origins that may call the API, for example the native apps: capacitor://localhost and https://localhost."
  type        = list(string)
  default     = []
}

variable "push_mode" {
  description = "off, or live once VAPID keys and/or the Firebase service account are in the secret."
  type        = string
  default     = "off"
}

variable "enable_waf" {
  description = "AWS WAF in front of CloudFront (managed rules and a per-IP rate limit)."
  type        = bool
  default     = true
}

variable "waf_rate_limit_per_5min" {
  description = "Requests per 5 minutes from one IP before WAF blocks it. A campus behind one NAT needs a high value; the API has its own, finer limits."
  type        = number
  default     = 20000
}

variable "alarm_email" {
  description = "Where alarms go (an SNS email subscription you must confirm)."
  type        = string
}

variable "log_retention_days" {
  type    = number
  default = 400
}
