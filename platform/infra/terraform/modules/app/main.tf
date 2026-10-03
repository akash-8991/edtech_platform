# Compute: ECR, ECS cluster, API / worker / ClamAV services on Fargate, an optional EC2 grader host, the load balancer and its certificate.

data "aws_caller_identity" "me" {}

locals {
  prefix        = "${var.name}-${var.environment}"
  prod          = var.environment == "prod"
  origin_domain = "origin.${var.domain_name}"
  namespace     = "${local.prefix}.local"
  cors_origins  = join(",", concat(["https://${var.domain_name}"], var.extra_cors_origins))
  image         = { for r in aws_ecr_repository.this : r.name => "${r.repository_url}:${var.image_tag}" }

  # No secret here: the process reads them itself from Secrets Manager at start-up using its task role.
  common_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "AWS_REGION", value = var.region },
    { name = "SECRETS_MANAGER_SECRET_ID", value = var.secret_name },
    { name = "STORAGE_DRIVER", value = "s3" },
    { name = "S3_BUCKET", value = var.media_bucket },
    { name = "S3_REGION", value = var.region },
    { name = "S3_KMS_KEY_ID", value = var.kms_key_arn },
    { name = "SCANNER", value = "clamav" },
    { name = "CLAMD_HOST", value = "clamav.${local.namespace}" },
    { name = "CORS_ORIGINS", value = local.cors_origins },
    { name = "TRUST_PROXY", value = "2" }, # CloudFront, then the load balancer
    { name = "PUSH_MODE", value = var.push_mode },
  ]
}

# ---- container registry ------------------------------------------------------------------------------------------------------------------------------
resource "aws_ecr_repository" "this" {
  for_each             = toset(["api", "worker", "api-migrate", "grader"])
  name                 = "${local.prefix}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = !local.prod
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({
    rules = [{ rulePriority = 1, description = "keep the last 30 images", selection = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }, action = { type = "expire" } }]
  })
}

# ---- logs, cluster, discovery ------------------------------------------------------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.prefix}"
  retention_in_days = var.log_retention_days # encrypted at rest by CloudWatch itself
}

resource "aws_ecs_cluster" "this" {
  name = local.prefix
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name = local.namespace
  vpc  = var.vpc_id
}

# ---- IAM ---------------------------------------------------------------------------------------------------------------------------------------------
data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: lets ECS pull the image and write logs. Nothing else.
resource "aws_iam_role" "exec" {
  name               = "${local.prefix}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "exec" {
  role       = aws_iam_role.exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Only the one-off migration task takes a value from the secret through ECS; running services read it themselves with the task role.
resource "aws_iam_role_policy" "exec_secret" {
  name = "read-the-app-secret"
  role = aws_iam_role.exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = var.secret_arn },
      { Effect = "Allow", Action = "kms:Decrypt", Resource = var.kms_key_arn },
    ]
  })
}

# Task role: what the application itself may do at run time. No static AWS keys exist anywhere.
resource "aws_iam_role" "task" {
  name               = "${local.prefix}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy" "task" {
  name = "app"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Media", Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"], Resource = [var.media_bucket_arn, "${var.media_bucket_arn}/*"] },
      { Sid = "Kms", Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = var.kms_key_arn },
      { Sid = "Secret", Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = var.secret_arn },
    ]
  })
}

# ---- task definitions --------------------------------------------------------------------------------------------------------------------------------
locals {
  log_config = { for n in ["api", "worker", "clamav", "migrate", "grader"] : n => {
    logDriver = "awslogs"
    options   = { "awslogs-group" = aws_cloudwatch_log_group.app.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = n }
  } }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.prefix}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.exec.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name                   = "api"
    image                  = local.image["${local.prefix}/api"]
    essential              = true
    command                = ["node", "dist/src/main.js"]
    portMappings           = [{ containerPort = 3000, protocol = "tcp" }]
    environment            = concat(local.common_env, [{ name = "PROCESS_ROLE", value = "api" }])
    logConfiguration       = local.log_config["api"]
    readonlyRootFilesystem = false
    stopTimeout            = 30
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.prefix}-worker"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.exec.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name      = "worker"
    image     = local.image["${local.prefix}/worker"]
    essential = true
    command   = ["node", "dist/src/worker.js"]
    # Grading jobs belong to the grader (the only place with a Docker daemon): this worker never claims them.
    environment      = concat(local.common_env, [{ name = "PROCESS_ROLE", value = "worker" }, { name = "WORKER_JOB_KINDS", value = "CURRICULUM,TOPIC_CONTENT,TRANSCODE" }])
    logConfiguration = local.log_config["worker"]
    stopTimeout      = 60
  }])
}

# One-off: database migrations (run by the pipeline before a new version takes traffic).
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.prefix}-migrate"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.exec.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name        = "migrate"
    image       = local.image["${local.prefix}/api-migrate"]
    essential   = true
    command     = ["npx", "prisma", "migrate", "deploy"]
    environment = local.common_env
    # prisma reads DATABASE_URL itself, so ECS injects just that key of the secret (the application process loads the secret on its own)
    secrets          = [{ name = "DATABASE_URL", valueFrom = "${var.secret_arn}:DATABASE_URL::" }]
    logConfiguration = local.log_config["migrate"]
  }])
}

resource "aws_ecs_task_definition" "clamav" {
  family                   = "${local.prefix}-clamav"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 1024
  memory                   = 3072
  execution_role_arn       = aws_iam_role.exec.arn
  container_definitions = jsonencode([{
    name         = "clamav"
    image        = var.clamav_image
    essential    = true
    portMappings = [{ containerPort = 3310, protocol = "tcp" }]
    # clamd answers PING only once signatures are loaded: that is when it may receive traffic.
    healthCheck      = { command = ["CMD-SHELL", "echo PING | nc -w 2 127.0.0.1 3310 | grep -q PONG"], interval = 30, timeout = 5, retries = 5, startPeriod = 240 }
    logConfiguration = local.log_config["clamav"]
  }])
}

# ---- services ----------------------------------------------------------------------------------------------------------------------------------------
resource "aws_ecs_service" "api" {
  name                               = "api"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.api_min_tasks
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60
  enable_execute_command             = false
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.app_security_group_id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }
  lifecycle {
    ignore_changes = [desired_count] # autoscaling owns it
  }
  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_service" "worker" {
  name                               = "worker"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = var.worker_tasks
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.app_security_group_id]
    assign_public_ip = false
  }
}

resource "aws_service_discovery_service" "clamav" {
  name = "clamav"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_ecs_service" "clamav" {
  name            = "clamav"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.clamav.arn
  desired_count   = local.prod ? 2 : 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.clamav_security_group_id]
    assign_public_ip = false
  }
  service_registries {
    registry_arn = aws_service_discovery_service.clamav.arn
  }
}

# ---- autoscaling of the API --------------------------------------------------------------------------------------------------------------------------
resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_min_tasks
  max_capacity       = var.api_max_tasks
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.prefix}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value       = 55
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
  }
}

# Requests per task: scales on load the CPU number lags behind (an exam start is a wall of requests).
resource "aws_appautoscaling_policy" "api_requests" {
  name               = "${local.prefix}-api-requests"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value       = 600
    scale_in_cooldown  = 300
    scale_out_cooldown = 30
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.this.arn_suffix}/${aws_lb_target_group.api.arn_suffix}"
    }
  }
}

# ---- load balancer and its certificate ---------------------------------------------------------------------------------------------------------------
resource "aws_lb" "this" {
  name                       = local.prefix
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = var.public_subnet_ids
  security_groups            = [var.alb_security_group_id]
  idle_timeout               = 120
  drop_invalid_header_fields = true
  enable_deletion_protection = local.prod
}

resource "aws_lb_target_group" "api" {
  name                 = "${local.prefix}-api"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  health_check {
    path                = "/health/ready"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }
}

resource "aws_acm_certificate" "origin" {
  domain_name       = local.origin_domain
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "origin_validation" {
  for_each = var.hosted_zone_id == "" ? {} : { for o in aws_acm_certificate.origin.domain_validation_options : o.domain_name => o }
  zone_id  = var.hosted_zone_id
  name     = each.value.resource_record_name
  type     = each.value.resource_record_type
  records  = [each.value.resource_record_value]
  ttl      = 60
}

resource "aws_acm_certificate_validation" "origin" {
  count                   = var.hosted_zone_id == "" ? 0 : 1
  certificate_arn         = aws_acm_certificate.origin.arn
  validation_record_fqdns = [for r in aws_route53_record.origin_validation : r.fqdn]
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.hosted_zone_id == "" ? aws_acm_certificate.origin.arn : aws_acm_certificate_validation.origin[0].certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# /metrics is for the monitoring system inside the network, never for the internet.
resource "aws_lb_listener_rule" "block_metrics" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 1
  action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "forbidden"
      status_code  = "403"
    }
  }
  condition {
    path_pattern { values = ["/metrics", "/metrics/*"] }
  }
}

resource "aws_route53_record" "origin" {
  count   = var.hosted_zone_id == "" ? 0 : 1
  zone_id = var.hosted_zone_id
  name    = local.origin_domain
  type    = "A"
  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}
