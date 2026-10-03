# Alarms that tell a person something is wrong before a learner does. They complement the application's own metrics and the rules in platform/ops/prometheus/alerts.yml.

locals {
  prefix = "${var.name}-${var.environment}"
}

resource "aws_sns_topic" "alarms" {
  name              = "${local.prefix}-alarms"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email # AWS sends a confirmation link: the alarms are silent until it is clicked
}

locals {
  actions = [aws_sns_topic.alarms.arn]
}

# ---- the API as users see it -------------------------------------------------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.prefix}-api-5xx"
  alarm_description   = "More than 1% of requests failed with a server error for 10 minutes."
  comparison_operator = "GreaterThanThreshold"
  threshold           = 1
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  metric_query {
    id          = "rate"
    expression  = "100 * errors / MAX([errors, requests])"
    label       = "5xx percent"
    return_data = true
  }
  metric_query {
    id = "errors"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
    }
  }
  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_latency" {
  alarm_name          = "${local.prefix}-api-p95-latency"
  alarm_description   = "The slowest 5% of API responses took more than 2 seconds for 10 minutes (the platform's target is p95 under 2 s)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 2
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  alarm_name          = "${local.prefix}-api-unhealthy-targets"
  alarm_description   = "The load balancer sees API tasks failing their health check."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# ---- compute -----------------------------------------------------------------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "api_cpu" {
  alarm_name          = "${local.prefix}-api-cpu"
  alarm_description   = "API CPU above 80% for 15 minutes: autoscaling is not keeping up or the maximum task count is too low."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { ClusterName = var.cluster_name, ServiceName = var.api_service_name }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "api_memory" {
  alarm_name          = "${local.prefix}-api-memory"
  alarm_description   = "API memory above 85% for 15 minutes."
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { ClusterName = var.cluster_name, ServiceName = var.api_service_name }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "worker_down" {
  alarm_name          = "${local.prefix}-worker-not-running"
  alarm_description   = "No worker task is running: exams are not swept, results and notifications are not sent, videos and grades are not processed."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  dimensions          = { ClusterName = var.cluster_name, ServiceName = var.worker_service_name }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# ---- database ----------------------------------------------------------------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${local.prefix}-db-cpu"
  alarm_description   = "Database CPU above 80% for 15 minutes. At exam start this is the first thing to saturate: consider a larger class or RDS Proxy."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { DBInstanceIdentifier = var.db_identifier }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name          = "${local.prefix}-db-free-storage"
  alarm_description   = "Less than 10 GB of database storage left."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10737418240
  comparison_operator = "LessThanThreshold"
  dimensions          = { DBInstanceIdentifier = var.db_identifier }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "db_connections" {
  alarm_name          = "${local.prefix}-db-connections"
  alarm_description   = "Many database connections in use: tasks times connection_limit may be approaching max_connections."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.db_connection_alarm
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { DBInstanceIdentifier = var.db_identifier }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "db_memory" {
  alarm_name          = "${local.prefix}-db-freeable-memory"
  alarm_description   = "Database freeable memory under 500 MB."
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 524288000
  comparison_operator = "LessThanThreshold"
  dimensions          = { DBInstanceIdentifier = var.db_identifier }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# ---- Redis -------------------------------------------------------------------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "redis_cpu" {
  alarm_name          = "${local.prefix}-redis-engine-cpu"
  alarm_description   = "Redis engine CPU above 80%: rate limiting and session checks are slowing every request."
  namespace           = "AWS/ElastiCache"
  metric_name         = "EngineCPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { ReplicationGroupId = var.redis_replication_group_id }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# ---- what the application itself reports --------------------------------------------------------------------------------------------------------------
resource "aws_cloudwatch_log_metric_filter" "errors" {
  name           = "${local.prefix}-app-errors"
  log_group_name = var.log_group_name
  pattern        = "{ $.level = \"error\" }"
  metric_transformation {
    name      = "ApplicationErrors"
    namespace = "${var.name}/${var.environment}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "app_errors" {
  alarm_name          = "${local.prefix}-application-errors"
  alarm_description   = "The application logged more than 20 errors in 10 minutes (integrity-check failures, failed jobs, provider outages all log at error level)."
  namespace           = "${var.name}/${var.environment}"
  metric_name         = "ApplicationErrors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 20
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  depends_on          = [aws_cloudwatch_log_metric_filter.errors]
}
