# Wires the modules together. Read README.md first: the order of the first apply matters (images must exist before the services can start).

module "network" {
  source             = "./modules/network"
  name               = var.name
  environment        = var.environment
  region             = var.region
  vpc_cidr           = var.vpc_cidr
  single_nat_gateway = var.single_nat_gateway
  log_retention_days = var.log_retention_days
}

module "data" {
  source                   = "./modules/data"
  name                     = var.name
  environment              = var.environment
  vpc_id                   = module.network.vpc_id
  private_subnet_ids       = module.network.private_subnet_ids
  app_security_group_id    = module.network.app_security_group_id
  db_instance_class        = var.db_instance_class
  db_allocated_storage     = var.db_allocated_storage
  db_max_allocated_storage = var.db_max_allocated_storage
  redis_node_type          = var.redis_node_type
}

module "app" {
  source                   = "./modules/app"
  name                     = var.name
  environment              = var.environment
  region                   = var.region
  vpc_id                   = module.network.vpc_id
  vpc_cidr                 = var.vpc_cidr
  public_subnet_ids        = module.network.public_subnet_ids
  private_subnet_ids       = module.network.private_subnet_ids
  alb_security_group_id    = module.network.alb_security_group_id
  app_security_group_id    = module.network.app_security_group_id
  clamav_security_group_id = module.network.clamav_security_group_id
  kms_key_arn              = module.data.kms_key_arn
  media_bucket             = module.data.media_bucket
  media_bucket_arn         = module.data.media_bucket_arn
  secret_arn               = module.data.secret_arn
  secret_name              = module.data.secret_name
  domain_name              = var.domain_name
  hosted_zone_id           = var.hosted_zone_id
  image_tag                = var.image_tag
  api_cpu                  = var.api_cpu
  api_memory               = var.api_memory
  api_min_tasks            = var.api_min_tasks
  api_max_tasks            = var.api_max_tasks
  worker_cpu               = var.worker_cpu
  worker_memory            = var.worker_memory
  worker_tasks             = var.worker_tasks
  extra_cors_origins       = var.extra_cors_origins
  push_mode                = var.push_mode
  log_retention_days       = var.log_retention_days
  enable_grader            = var.enable_grader
  grader_instance_type     = var.grader_instance_type
  sandbox_image_python     = var.sandbox_image_python
}

module "web" {
  source                  = "./modules/web"
  providers               = { aws = aws, aws.us_east_1 = aws.us_east_1 }
  name                    = var.name
  environment             = var.environment
  domain_name             = var.domain_name
  origin_domain           = module.app.origin_domain
  hosted_zone_id          = var.hosted_zone_id
  enable_waf              = var.enable_waf
  waf_rate_limit_per_5min = var.waf_rate_limit_per_5min
}

module "observability" {
  source                     = "./modules/observability"
  name                       = var.name
  environment                = var.environment
  alarm_email                = var.alarm_email
  alb_arn_suffix             = module.app.alb_arn_suffix
  target_group_arn_suffix    = module.app.target_group_arn_suffix
  cluster_name               = module.app.cluster_name
  api_service_name           = module.app.api_service_name
  worker_service_name        = module.app.worker_service_name
  db_identifier              = module.data.db_identifier
  redis_replication_group_id = module.data.redis_replication_group_id
  log_group_name             = module.app.log_group_name
}

# A guard the plan cannot express: the sandbox must be pinned by digest, or a tag could change under us.
check "sandbox_image_is_pinned" {
  assert {
    condition     = !var.enable_grader || can(regex("@sha256:[0-9a-f]{64}$", var.sandbox_image_python))
    error_message = "enable_grader needs sandbox_image_python pinned by digest, for example python@sha256:<64 hex characters>."
  }
}
