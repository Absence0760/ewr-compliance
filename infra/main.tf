terraform {
  # use_lockfile needs 1.10+; cross-variable validation (variables.tf) 1.9+.
  # The exact version is pinned for tfenv in infra/.terraform-version, and CI
  # reads the same file (.github/workflows/terraform.yml).
  required_version = ">= 1.11"

  # Partial backend config: the bucket name embeds the account ID, which stays
  # out of this public repo. The estate bootstrap
  # (~/github/templates/scripts/new-project-account.sh ewr-compliance) creates
  # the bucket as `ewr-compliance-tfstate-<account-id>`, versioned and
  # encrypted, in us-east-1. The operator writes infra/backend.config
  # (gitignored; shape in backend.config.example) and runs
  #
  #   terraform init -backend-config=backend.config
  #
  # Locking uses S3 conditional writes (use_lockfile), no DynamoDB table. The
  # state bucket is always us-east-1, whatever var.aws_region is.
  backend "s3" {
    key          = "prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.44"
    }
    # The API's stub package (auth.tf); CI uploads the real code.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# The workload region: the site bucket, the signing-key secret and, from P3/P4
# on, the Lambdas, the user table and the DWS store.
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}

# CloudFront requires its certificate, its WAF web ACL and its metrics in
# us-east-1, and Budgets and Cost Explorer publish from there.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.tags
  }
}

locals {
  project = "ewr-compliance"

  tags = {
    Project     = local.project
    ManagedBy   = "terraform"
    Environment = "production"
    Repository  = var.github_repo
  }
}

data "aws_caller_identity" "current" {}
