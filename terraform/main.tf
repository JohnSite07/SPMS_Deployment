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

module "network" {
  source     = "./modules/network"
  project_id = var.project_id
  region     = var.region
}

module "secrets" {
  source     = "./modules/secrets"
  project_id = var.project_id
}

module "data" {
  source     = "./modules/data"
  project_id = var.project_id
  region     = var.region
  network_id = module.network.network_id

  db_user_name = module.secrets.db_user_name
  db_password  = module.secrets.db_password

  # Cloud SQL private-IP creation requires the network module's Private
  # Services Access connection to exist first.
  depends_on = [module.network]
}

module "iam" {
  source     = "./modules/iam"
  project_id = var.project_id

  # All 6 app secrets — the runtime SA gets per-secret secretAccessor on each.
  secret_ids = module.secrets.all_secret_ids

  document_bucket_name = module.data.document_bucket_name
  github_repository    = var.github_repository
  billing_account_id   = var.billing_account_id
  developer_emails     = var.developer_emails
  developer_group      = var.developer_group
}

module "app" {
  source     = "./modules/app"
  project_id = var.project_id
  region     = var.region

  runtime_sa_email = module.iam.runtime_sa_email
  network_id       = module.network.network_id
  subnet_id        = module.network.subnet_id

  db_host               = module.data.private_ip_address
  db_name               = module.data.database_name
  db_user_name          = module.data.user_name
  documents_bucket_name = module.data.document_bucket_name

  db_password_secret_id        = module.secrets.db_password_secret_id
  jwt_signing_key_secret_id    = module.secrets.jwt_signing_key_secret_id
  aes_encryption_key_secret_id = module.secrets.aes_encryption_key_secret_id
  smtp_username_secret_id      = module.secrets.smtp_username_secret_id
  smtp_password_secret_id      = module.secrets.smtp_password_secret_id

  # Cloud Run must not attempt to read secrets before the runtime SA's
  # per-secret accessor bindings (module.iam) exist.
  depends_on = [module.iam]
}

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
