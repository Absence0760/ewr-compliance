# ----------------------------------------------------------------------------
# GitHub OIDC deploy role: bootstrap-owned, looked up here
#
# The OIDC provider and the role `<slug>-deploy` come from the estate bootstrap
# (~/github/templates/scripts/new-project-account.sh). Its trust policy pins
# the subject to this repo's `production` environment, behind the
# environment's required reviewer. This file only looks the role up, refuses a
# trust that has drifted wider, and attaches this project's deploy policy.
#
# What CI may do with it, and what it may not:
#   - Update the code of P3's API (auth.tf, once auth_enabled) and of the
#     Lambdas named in var.deploy_lambda_functions (P4's pipeline). Nothing
#     else: not their configuration, so CI can't point a function at another
#     role or environment.
#   - NEVER write the site bucket, or invalidate the distribution. The site and
#     its data, real or sample, go up only from the operator's workstation
#     (tools/deploy.sh). CI has no access to the real data and must not have.
#     infra/tests/iam.tftest.hcl fails if any S3 or CloudFront action appears.
#
# With no Lambdas yet (P1, P2) the policy would have no statements, which IAM
# refuses, so it and its attachment aren't created at all.
# ----------------------------------------------------------------------------

data "aws_iam_role" "github_deploy" {
  name = "${var.bootstrap_slug}-deploy"

  # The trust is bootstrap-owned, but everything granted below rides on it, so
  # the plan refuses a trust that allows more than "this repo's production
  # environment". The subject may be the slug form (repo:<owner>/<repo>) or
  # GitHub's immutable-claims form (repo:<owner>@<id>/<repo>@<id>), which the
  # bootstrap reads from the API. IAM collapses one-element lists to strings,
  # hence the flatten([...]). Copied from WM's oidc.tf.
  lifecycle {
    postcondition {
      condition = length([
        for s in flatten([try(jsondecode(self.assume_role_policy).Statement, [])]) : s if try(s.Effect, "") == "Allow"
        ]) > 0 && alltrue([
        for s in flatten([try(jsondecode(self.assume_role_policy).Statement, [])]) :
        try(s.Effect, "") != "Allow" || (
          toset(flatten([try(s.Action, [])])) == toset(["sts:AssumeRoleWithWebIdentity"]) &&
          length(flatten([try(s.Condition.StringEquals["token.actions.githubusercontent.com:sub"], [])])) == 1 &&
          alltrue([
            for sub in flatten([try(s.Condition.StringEquals["token.actions.githubusercontent.com:sub"], [])]) :
            can(regex(local.deploy_sub_pattern, sub))
          ]) &&
          toset(flatten([try(s.Condition.StringEquals["token.actions.githubusercontent.com:aud"], [])])) == toset(["sts.amazonaws.com"]) &&
          length(keys(try(s.Condition.StringLike, {}))) == 0
        )
      ])
      error_message = "The bootstrap deploy role's trust policy must allow only sts:AssumeRoleWithWebIdentity, with exactly one StringEquals sub for ${var.github_repo}'s `production` environment and aud = sts.amazonaws.com (no StringLike or wildcards). Fix the bootstrap before planning."
    }
  }
}

locals {
  # ^repo:<owner>(@<id>)?/<repo>(@<id>)?:environment:production$
  deploy_sub_pattern = format(
    "^repo:%s(@[0-9]+)?/%s(@[0-9]+)?:environment:production$",
    replace(split("/", var.github_repo)[0], ".", "\\."),
    replace(split("/", var.github_repo)[1], ".", "\\."),
  )

  # The API (auth.tf) by itself once it exists, then any others (P4).
  deploy_lambda_functions = distinct(concat(local.api_enabled ? [local.api_function_name] : [], var.deploy_lambda_functions))

  deploy_lambda_arns = [
    for name in local.deploy_lambda_functions :
    "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${name}"
  ]

  deploy_policy_enabled = length(local.deploy_lambda_functions) > 0
}

data "aws_iam_policy_document" "github_deploy" {
  count = local.deploy_policy_enabled ? 1 : 0

  statement {
    sid = "LambdaUpdate"
    actions = [
      "lambda:UpdateFunctionCode",
      "lambda:GetFunction",
      "lambda:GetFunctionConfiguration",
    ]
    resources = local.deploy_lambda_arns
  }
}

resource "aws_iam_policy" "github_deploy" {
  count  = local.deploy_policy_enabled ? 1 : 0
  name   = "${local.project}-github-deploy"
  policy = data.aws_iam_policy_document.github_deploy[0].json
}

resource "aws_iam_role_policy_attachment" "github_deploy" {
  count      = local.deploy_policy_enabled ? 1 : 0
  role       = data.aws_iam_role.github_deploy.name
  policy_arn = aws_iam_policy.github_deploy[0].arn
}
