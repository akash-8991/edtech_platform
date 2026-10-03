# The code-grading sandbox runs learner code in throw-away Docker containers. Fargate cannot run Docker, so the grader is a small EC2 host that only
# runs the grader worker. The worker never touches the Docker socket itself: a socket proxy that allows container create/start/wait/remove and nothing
# else (no exec, no images, no volumes, no networks) sits between them. The sandbox image is pulled onto the host when it starts, by digest.

data "aws_ssm_parameter" "ecs_ami" {
  count = var.enable_grader ? 1 : 0
  name  = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}

resource "aws_security_group" "grader" {
  count       = var.enable_grader ? 1 : 0
  name        = "${local.prefix}-grader"
  description = "Grader host: outbound only"
  vpc_id      = var.vpc_id
}

# HTTPS for ECS, ECR, Secrets Manager, logs; the database and Redis inside the VPC. Learner code runs with --network none, so none of this reaches it.
resource "aws_vpc_security_group_egress_rule" "grader_https" {
  count             = var.enable_grader ? 1 : 0
  security_group_id = aws_security_group.grader[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "grader_postgres" {
  count             = var.enable_grader ? 1 : 0
  security_group_id = aws_security_group.grader[0].id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
}

resource "aws_vpc_security_group_egress_rule" "grader_redis" {
  count             = var.enable_grader ? 1 : 0
  security_group_id = aws_security_group.grader[0].id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 6379
  to_port           = 6379
}

resource "aws_iam_role" "grader_host" {
  count = var.enable_grader ? 1 : 0
  name  = "${local.prefix}-grader-host"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "grader_host" {
  count      = var.enable_grader ? 1 : 0
  role       = aws_iam_role.grader_host[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_instance_profile" "grader" {
  count = var.enable_grader ? 1 : 0
  name  = "${local.prefix}-grader"
  role  = aws_iam_role.grader_host[0].name
}

resource "aws_launch_template" "grader" {
  count         = var.enable_grader ? 1 : 0
  name_prefix   = "${local.prefix}-grader-"
  image_id      = data.aws_ssm_parameter.ecs_ami[0].value
  instance_type = var.grader_instance_type
  iam_instance_profile { name = aws_iam_instance_profile.grader[0].name }
  vpc_security_group_ids = [aws_security_group.grader[0].id]
  user_data = base64encode(<<-EOT
    #!/bin/bash
    echo "ECS_CLUSTER=${aws_ecs_cluster.this.name}" >> /etc/ecs/ecs.config
    echo "ECS_ENABLE_TASK_IAM_ROLE=true" >> /etc/ecs/ecs.config
    systemctl enable --now docker
    docker pull ${var.sandbox_image_python}
  EOT
  )
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 1          # containers cannot reach the host's credentials
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = 30
      volume_type = "gp3"
      encrypted   = true
      kms_key_id  = var.kms_key_arn
    }
  }
}

resource "aws_autoscaling_group" "grader" {
  count                 = var.enable_grader ? 1 : 0
  name                  = "${local.prefix}-grader"
  min_size              = 1
  max_size              = 2
  desired_capacity      = 1
  vpc_zone_identifier   = var.private_subnet_ids
  protect_from_scale_in = true
  launch_template {
    id      = aws_launch_template.grader[0].id
    version = "$Latest"
  }
  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }
  lifecycle {
    ignore_changes = [desired_capacity]
  }
}

resource "aws_ecs_capacity_provider" "grader" {
  count = var.enable_grader ? 1 : 0
  name  = "${local.prefix}-grader"
  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.grader[0].arn
    managed_termination_protection = "ENABLED"
    managed_scaling {
      status          = "ENABLED"
      target_capacity = 100
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  count              = var.enable_grader ? 1 : 0
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", aws_ecs_capacity_provider.grader[0].name]
}

resource "aws_ecs_task_definition" "grader" {
  count                    = var.enable_grader ? 1 : 0
  family                   = "${local.prefix}-grader"
  network_mode             = "bridge"
  requires_compatibilities = ["EC2"]
  cpu                      = 1536
  memory                   = 3072
  execution_role_arn       = aws_iam_role.exec.arn
  task_role_arn            = aws_iam_role.task.arn
  volume {
    name      = "docker-sock"
    host_path = "/var/run/docker.sock"
  }
  container_definitions = jsonencode([
    {
      name      = "docker-proxy"
      image     = var.docker_socket_proxy_image
      essential = true
      cpu       = 128
      memory    = 128
      # Allowed: create, start, attach, wait, remove containers. Denied: exec, images, volumes, networks, swarm, info, build.
      environment = [
        { name = "CONTAINERS", value = "1" }, { name = "POST", value = "1" }, { name = "DELETE", value = "1" },
        { name = "IMAGES", value = "0" }, { name = "EXEC", value = "0" }, { name = "VOLUMES", value = "0" }, { name = "NETWORKS", value = "0" },
        { name = "INFO", value = "0" }, { name = "BUILD", value = "0" }, { name = "SWARM", value = "0" }, { name = "SECRETS", value = "0" }, { name = "SERVICES", value = "0" },
        { name = "TASKS", value = "0" }, { name = "NODES", value = "0" }, { name = "PLUGINS", value = "0" }, { name = "SYSTEM", value = "0" },
      ]
      mountPoints      = [{ sourceVolume = "docker-sock", containerPath = "/var/run/docker.sock", readOnly = false }]
      logConfiguration = local.log_config["grader"]
    },
    {
      name      = "grader"
      image     = local.image["${local.prefix}/grader"]
      essential = true
      cpu       = 1408
      memory    = 2944
      command   = ["node", "dist/src/worker.js"]
      links     = ["docker-proxy"]
      environment = concat(local.common_env, [
        { name = "PROCESS_ROLE", value = "worker" },
        { name = "WORKER_JOB_KINDS", value = "GRADE_SUBMISSION" },
        { name = "WORKER_SWEEPS", value = "0" }, # the Fargate worker runs the periodic sweeps; this one only grades
        { name = "SANDBOX_MODE", value = "docker" },
        { name = "SANDBOX_IMAGE_PYTHON", value = var.sandbox_image_python },
        { name = "DOCKER_HOST", value = "tcp://docker-proxy:2375" },
        { name = "WORKER_HEALTH_PORT", value = "3001" },
      ])
      logConfiguration = local.log_config["grader"]
    },
  ])
}

resource "aws_ecs_service" "grader" {
  count           = var.enable_grader ? 1 : 0
  name            = "grader"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.grader[0].arn
  desired_count   = 1
  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.grader[0].name
    weight            = 1
  }
  depends_on = [aws_ecs_cluster_capacity_providers.this]
}
