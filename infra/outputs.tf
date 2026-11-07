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
