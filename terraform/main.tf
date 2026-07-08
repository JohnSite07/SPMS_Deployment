provider "google" {
  project = var.project_id
  region  = var.region

  # The Billing Budgets API rejects plain user ADC without a quota project;
  # bill API calls to this project instead of the ADC default.
  user_project_override = true
  billing_project       = var.project_id
}

# --- Module wiring -----------------------------------------------------
# Modules are single-purpose (per CLAUDE.md) and are wired together here.
# Filled in by later PRDs (0002: network/data, 0003: iam, 0004+: app/secrets).

# module "network" {
#   source     = "./modules/network"
#   project_id = var.project_id
#   region     = var.region
# }

# module "iam" {
#   source     = "./modules/iam"
#   project_id = var.project_id
# }

# module "data" {
#   source     = "./modules/data"
#   project_id = var.project_id
#   region     = var.region
#   # network_id = module.network.network_id
# }

# module "app" {
#   source     = "./modules/app"
#   project_id = var.project_id
#   region     = var.region
#   # vpc_self_link = module.network.vpc_self_link
# }

# module "secrets" {
#   source     = "./modules/secrets"
#   project_id = var.project_id
# }

# --- Cost guardrail: billing budget --------------------------------------
# $300 USD budget scoped to this project, alerting at 50/90/100% of spend.
# Part of the managed estate per CLAUDE.md, not an afterthought.

# budget_filter.projects requires "projects/{project_number}", not the
# project ID — look up the numeric project number via a data source.
data "google_project" "current" {
  project_id = var.project_id
}

resource "google_billing_budget" "spms" {
  billing_account = var.billing_account_id
  display_name    = "SPMS SecureVault - $300 free trial budget"

  budget_filter {
    projects = ["projects/${data.google_project.current.number}"]
  }

  amount {
    specified_amount {
      # No currency_code: must match the billing account's currency (CAD for
      # this account); omitting it defaults to the account currency.
      units = "300"
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }

  threshold_rules {
    threshold_percent = 0.9
  }

  threshold_rules {
    threshold_percent = 1.0
  }
}
