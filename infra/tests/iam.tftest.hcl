# Plan-only IAM tests against the same mocked providers as
# guardrails.tftest.hcl. A mocked aws_iam_policy_document renders a fixed
# JSON, so every assertion reads the data source's `statement` inputs.
#
# Pinned here: the deploy role gets nothing until there are Lambdas, then
# only their code updates, and never S3 or CloudFront (the site and its data
# go up only from the workstation); the bootstrap role's trust must name this
# repo's production environment and nothing wider; the alert topics accept
# only this account's publishers.

# --- Mocks: copied into every test file (a test file can't share them) -------
# A mocked aws_iam_policy_document renders a random string, which IAM, SNS and
# S3 policy arguments reject as invalid JSON; any well-formed document does.
# Assertions read a document's statement inputs, never its json.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "000000000000"
    }
  }
  mock_data "aws_iam_role" {
    defaults = {
      arn  = "arn:aws:iam::000000000000:role/ewr-compliance-deploy"
      name = "ewr-compliance-deploy"
      # The bootstrap's trust as IAM returns it (single values collapsed to
      # strings): templates infra/modules/project-baseline.
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Federated\":\"arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com\"},\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:test-owner/ewr-compliance:environment:production\"}}}]}"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

mock_provider "random" {}

# Known IDs and ARNs, so the wiring can be asserted by equality at plan time.
override_resource {
  target          = aws_acm_certificate.site
  override_during = plan
  values = {
    arn = "arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000"
    domain_validation_options = [{
      domain_name           = "ewr.example.org"
      resource_record_name  = "_0123abcd.ewr.example.org."
      resource_record_type  = "CNAME"
      resource_record_value = "_4567efab.acm-validations.aws."
    }]
  }
}

override_resource {
  target          = aws_wafv2_web_acl.site
  override_during = plan
  values = {
    arn = "arn:aws:wafv2:us-east-1:000000000000:global/webacl/ewr-compliance-site-acl/00000000-0000-0000-0000-000000000000"
  }
}

override_resource {
  target          = aws_cloudfront_key_group.signing
  override_during = plan
  values = {
    id = "kg-test"
  }
}

override_resource {
  target          = aws_cloudfront_function.site_request
  override_during = plan
  values = {
    arn = "arn:aws:cloudfront::000000000000:function/ewr-compliance-site-request"
  }
}

override_resource {
  target          = aws_cloudfront_response_headers_policy.site
  override_during = plan
  values = {
    id = "rhp-site"
  }
}

override_resource {
  target          = aws_cloudfront_response_headers_policy.api
  override_during = plan
  values = {
    id = "rhp-api"
  }
}

override_resource {
  target          = aws_cloudfront_distribution.site
  override_during = plan
  values = {
    id  = "EDISTTEST"
    arn = "arn:aws:cloudfront::000000000000:distribution/EDISTTEST"
  }
}

override_resource {
  target          = aws_sns_topic.alerts_us_east_1
  override_during = plan
  values = {
    arn = "arn:aws:sns:us-east-1:000000000000:ewr-compliance-prod-alerts"
  }
}

variables {
  aws_region         = "af-south-1"
  github_repo        = "test-owner/ewr-compliance"
  domain_name        = "ewr.example.org"
  route53_zone_id    = "Z0000000000000000000"
  budget_alert_email = "alerts@mail.ewr-test.net"
  # A public key generated for these tests; its private half was never kept.
  # Public keys aren't secret. Unused while site_enabled is false.
  cloudfront_public_keys = {
    "test" = <<-EOT
      -----BEGIN PUBLIC KEY-----
      MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqVimeMBRXL+udlnELOIu
      AZ8mjzqJjY+dLf555KMmNdQxFnyoy78gzpzHNJGQNHlUS6qnKfFQ61I7S/hOTnhi
      QiGBTUTJ5KQ3vBh9Y/hX/7/Qnc/EyJ9PtMTc1Jski8ycMMp0g39xkD6m0/NOkOHk
      n2P1/R5EFC5p/iyfB9Qn+qD95zP5EDCCYhLjrDN7eWIN/1Mvr8Gltpw+8I4Mi8Mq
      y+voRUvpPmNXfHIrWUeX1Z+fIaMkacr4d/AxHh7bwSdJtJBgXCOyBtdUdK3GZlwm
      G8gL6d2X3X8FJRqWZZBmnlPLrwisFN/9yEnRR7+QVS1OUkm31jTs0oI8cUUF+Wwj
      hwIDAQAB
      -----END PUBLIC KEY-----
    EOT
  }
}

run "no_deploy_policy_without_lambdas" {
  command = plan
  variables {
    site_enabled = true
  }
  assert {
    condition     = length(data.aws_iam_policy_document.github_deploy) == 0 && length(aws_iam_policy.github_deploy) == 0
    error_message = "No Lambdas, no deploy policy: CI can do nothing in this account yet."
  }
}

run "deploy_policy_is_lambda_code_only" {
  command = plan
  variables {
    site_enabled            = true
    deploy_lambda_functions = ["ewr-compliance-api", "ewr-compliance-dws"]
  }

  assert {
    condition = toset(flatten([for s in data.aws_iam_policy_document.github_deploy[0].statement : s.actions])) == toset([
      "lambda:UpdateFunctionCode", "lambda:GetFunction", "lambda:GetFunctionConfiguration",
    ])
    error_message = "The deploy role may update and read the named Lambdas, nothing else."
  }
  assert {
    condition = length([for a in flatten([for s in data.aws_iam_policy_document.github_deploy[0].statement : s.actions]) :
    a if startswith(a, "s3:") || startswith(a, "cloudfront:") || strcontains(a, "*")]) == 0
    error_message = "CI must never write the site bucket or invalidate the distribution: the data goes up from the workstation only."
  }
  assert {
    condition = toset(flatten([for s in data.aws_iam_policy_document.github_deploy[0].statement : s.resources])) == toset([
      "arn:aws:lambda:af-south-1:000000000000:function:ewr-compliance-api",
      "arn:aws:lambda:af-south-1:000000000000:function:ewr-compliance-dws",
    ])
    error_message = "Each Lambda by its full ARN, no wildcard."
  }
  assert {
    condition     = aws_iam_role_policy_attachment.github_deploy[0].role == "ewr-compliance-deploy"
    error_message = "The policy goes on the bootstrap's deploy role."
  }
}

run "rejects_a_wildcard_lambda" {
  command = plan
  variables {
    deploy_lambda_functions = ["ewr-compliance-*"]
  }
  expect_failures = [var.deploy_lambda_functions]
}

run "rejects_another_projects_lambda" {
  command = plan
  variables {
    deploy_lambda_functions = ["water-management-api"]
  }
  expect_failures = [var.deploy_lambda_functions]
}

# --- The bootstrap role's trust -----------------------------------------------

run "accepts_immutable_claims_subject" {
  command = plan
  override_data {
    target = data.aws_iam_role.github_deploy
    values = {
      name               = "ewr-compliance-deploy"
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:test-owner@123/ewr-compliance@456:environment:production\"}}}]}"
    }
  }
}

run "refuses_a_trust_with_stringlike" {
  command = plan
  override_data {
    target = data.aws_iam_role.github_deploy
    values = {
      name               = "ewr-compliance-deploy"
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:test-owner/ewr-compliance:environment:production\"},\"StringLike\":{\"token.actions.githubusercontent.com:sub\":\"repo:test-owner/*\"}}}]}"
    }
  }
  expect_failures = [data.aws_iam_role.github_deploy]
}

run "refuses_a_trust_for_a_branch" {
  command = plan
  override_data {
    target = data.aws_iam_role.github_deploy
    values = {
      name               = "ewr-compliance-deploy"
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:test-owner/ewr-compliance:ref:refs/heads/main\"}}}]}"
    }
  }
  expect_failures = [data.aws_iam_role.github_deploy]
}

run "refuses_a_trust_for_another_repo" {
  command = plan
  override_data {
    target = data.aws_iam_role.github_deploy
    values = {
      name               = "ewr-compliance-deploy"
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:test-owner/other:environment:production\"}}}]}"
    }
  }
  expect_failures = [data.aws_iam_role.github_deploy]
}

# --- Alert topics -------------------------------------------------------------

run "alert_topics_accept_only_this_account" {
  command = plan

  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.alerts_publish.statement :
    s.actions == toset(["sns:Publish"]) && contains([for c in s.condition : c.variable], "aws:SourceAccount")])
    error_message = "The regional topic takes Publish only, from this account."
  }
  assert {
    condition     = toset([for s in data.aws_iam_policy_document.alerts_us_east_1_publish.statement : one(s.principals).identifiers]) == toset([toset(["cloudwatch.amazonaws.com"]), toset(["budgets.amazonaws.com"]), toset(["costalerts.amazonaws.com"])])
    error_message = "The us-east-1 topic takes CloudWatch, Budgets and Cost Anomaly Detection, nothing else."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.alerts_us_east_1_publish.statement :
    contains([for c in s.condition : c.variable], "aws:SourceAccount")])
    error_message = "Every publisher to the us-east-1 topic is pinned to this account."
  }
}
