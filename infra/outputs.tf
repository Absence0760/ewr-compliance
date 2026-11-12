# Read by tools/deploy.sh (site_bucket, distribution_id) and by the operator.
# No secret here: the signing key's value is never in Terraform.

output "site_bucket" {
  description = "The private site bucket tools/deploy.sh syncs build/ into."
  value       = var.site_enabled ? aws_s3_bucket.site[0].bucket : null
}

output "distribution_id" {
  description = "The CloudFront distribution tools/deploy.sh invalidates after a sync."
  value       = var.site_enabled ? aws_cloudfront_distribution.site[0].id : null
}

output "distribution_domain" {
  description = "The distribution's own *.cloudfront.net name, which the A/AAAA alias records point at."
  value       = var.site_enabled ? aws_cloudfront_distribution.site[0].domain_name : null
}

output "signing_key_secret_arn" {
  description = "The empty secret the operator puts the CloudFront private key into (H7)."
  value       = var.site_enabled ? aws_secretsmanager_secret.signing_key[0].arn : null
}

output "signing_public_key_ids" {
  description = "Each public key's CloudFront ID, by name: the CloudFront-Key-Pair-Id the API (P3) signs with."
  value       = { for k, v in aws_cloudfront_public_key.signing : k => v.id }
}

output "alerts_topic_arns" {
  description = "The alert topics: regional (Lambda and store alarms) and us-east-1 (CloudFront, WAF, budgets)."
  value = {
    regional  = aws_sns_topic.alerts.arn
    us_east_1 = aws_sns_topic.alerts_us_east_1.arn
  }
}

output "api_function_name" {
  description = "The API Lambda (auth.tf): the GitHub variable API_FUNCTION_NAME deploy-lambdas.yml updates."
  value       = local.api_enabled ? aws_lambda_function.api[0].function_name : null
}

output "users_table" {
  description = "The user table, which tools/first-admin, recover-admin and erase-user act on."
  value       = local.api_enabled ? aws_dynamodb_table.users[0].name : null
}

output "auth_runtime_secret_arn" {
  description = "The API's runtime secret (the keys); the operator tools read the keys from it with the operator's own credentials. Its value is never an output."
  value       = local.api_enabled ? aws_secretsmanager_secret.auth_runtime[0].arn : null
}

output "ses_identity" {
  description = "The SES domain identity; H8 checks its DKIM status reads SUCCESS."
  value       = local.api_enabled ? aws_sesv2_email_identity.domain[0].email_identity : null
}

output "dws_bucket" {
  description = "The DWS store's bucket: tools/dws-stations.sh uploads config/stations.json to it."
  value       = var.dws_enabled ? aws_s3_bucket.dws[0].bucket : null
}

output "dws_function_name" {
  description = "The DWS pipeline Lambda, which deploy-lambdas.yml updates."
  value       = var.dws_enabled ? aws_lambda_function.dws[0].function_name : null
}

output "dws_backfill_state_machine_arn" {
  description = "The backfill the operator starts with tools/dws-backfill-plan.mjs's input."
  value       = var.dws_enabled ? aws_sfn_state_machine.dws_backfill[0].arn : null
}

output "dws_api_key_secret_arn" {
  description = "The empty secret the operator puts the DWS API key into, once DWS issues one."
  value       = var.dws_enabled ? aws_secretsmanager_secret.dws_api_key[0].arn : null
}

output "nodes_bucket" {
  description = "The admin node store's bucket (nodes.tf), which the API writes: where the operator restores a WMA's previous version."
  value       = local.nodes == 1 ? aws_s3_bucket.nodes[0].bucket : null
}

output "aws_region" {
  description = "The workload region, which tools/breaker-reset.sh reads."
  value       = var.aws_region
}

output "api_reserved_concurrency" {
  description = "The API's reserved concurrency as Terraform sets it: a number, or \"none\" (unreserved). tools/breaker-reset.sh reopens the API to it."
  value       = var.api_reserved_concurrency == null ? "none" : tostring(var.api_reserved_concurrency)
}

output "breaker_protected_functions" {
  description = "The functions the spend breaker (breaker.tf) stops, by its alarm-name prefix; tools/breaker-reset.sh re-arms and reopens them."
  value       = local.breaker_targets
}

output "cloudfront_flat_rate_subscription" {
  description = "The CloudFront flat-rate plan subscription (flat_rate_plan.tf), when cloudfront_flat_rate_plan isn't \"none\": its ARN and status (PENDING_APPROVAL until the operator approves it in the console)."
  value = var.cloudfront_flat_rate_plan == "none" ? null : {
    arn    = aws_pricingplanmanager_subscription.cloudfront[0].arn
    status = aws_pricingplanmanager_subscription.cloudfront[0].status
  }
}
