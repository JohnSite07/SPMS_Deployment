# iam module — single purpose: least-privilege service accounts (pipeline vs.
# runtime) and Workload Identity Federation pool/provider for keyless CI/CD.
# No google_service_account_key resources exist anywhere in this module —
# keyless auth end to end.

# --- Service accounts ----------------------------------------------------

resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = var.runtime_sa_account_id
  display_name = "SPMS Cloud Run runtime service account"
  description  = "Identity Cloud Run assumes at request time; least-privilege, scoped to Cloud SQL client, its own secrets, and its own bucket."
}

resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = var.deployer_sa_account_id
  display_name = "SPMS CI/CD deployer service account"
  description  = "Identity GitHub Actions impersonates via WIF (no key) to run terraform apply, build/push images, and deploy Cloud Run revisions."
}

# --- Runtime SA: project-level roles --------------------------------------

locals {
  runtime_project_roles = [
    "roles/cloudsql.client",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ]

  deployer_project_roles = [
    "roles/run.admin",
    "roles/artifactregistry.writer",
    "roles/cloudsql.admin",
    "roles/compute.networkAdmin",
    "roles/secretmanager.admin",
    "roles/storage.admin",
    "roles/serviceusage.serviceUsageAdmin",
    "roles/iam.serviceAccountAdmin",
    "roles/resourcemanager.projectIamAdmin",
    # Terraform plan/apply must read+manage the WIF pool/provider it declares;
    # none of the roles above cover iam.workloadIdentityPools.* (found live:
    # first CI plan failed IAM_PERMISSION_DENIED refreshing the pool).
    "roles/iam.workloadIdentityPoolAdmin",
  ]
}

resource "google_project_iam_member" "runtime" {
  for_each = toset(local.runtime_project_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# --- Runtime SA: per-secret and bucket-scoped roles -----------------------
# Deliberately not project-wide: secretAccessor is per-secret, storage.objectAdmin
# is scoped to the single document bucket.

resource "google_secret_manager_secret_iam_member" "runtime_secret_accessor" {
  for_each = toset(var.secret_ids)

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_storage_bucket_iam_member" "runtime_bucket_object_admin" {
  bucket = var.document_bucket_name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

# --- Deployer SA: project-level roles --------------------------------------
# Widest role list in the project because it applies all Terraform for the
# estate; mitigated by the repo-pinned WIF condition below (see ADR).

resource "google_project_iam_member" "deployer" {
  for_each = toset(local.deployer_project_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# Deployer may act as the runtime SA (to deploy Cloud Run revisions running as
# it) — granted on the runtime SA resource only, never project-wide.
resource "google_service_account_iam_member" "deployer_run_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

# The billing budget lives on the billing ACCOUNT, not the project — project
# roles grant nothing there. costsManager is the narrowest role that lets the
# pipeline's terraform apply read/manage budgets (it cannot change payment
# settings or link/unlink projects).
resource "google_billing_account_iam_member" "deployer_costs_manager" {
  billing_account_id = var.billing_account_id
  role               = "roles/billing.costsManager"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

# --- Workload Identity Federation: GitHub Actions, keyless -----------------

resource "google_iam_workload_identity_pool" "pool" {
  project                   = var.project_id
  workload_identity_pool_id = var.wif_pool_id
  display_name              = "SPMS CI/CD pool"
  description               = "Workload Identity Pool trusting GitHub Actions OIDC tokens for keyless deploys."
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.pool.workload_identity_pool_id
  workload_identity_pool_provider_id = var.wif_provider_id
  display_name                       = "GitHub Actions"
  description                        = "Trusts short-lived OIDC tokens from ${var.github_repository} only."

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  # Pinned to this repository — tokens from any other repo are rejected here,
  # independently of the downstream IAM binding below.
  attribute_condition = "assertion.repository == \"${var.github_repository}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Only workflows from the pinned repository (via the pool's repository
# attribute) may impersonate the deployer SA — no other principal can.
resource "google_service_account_iam_member" "deployer_wif_binding" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.pool.name}/attribute.repository/${var.github_repository}"
}

# --- Developer team: human read access -------------------------------------
# Read-only paths only (secrets, logs, DB client, registry/run viewer) — no
# deploy or IAM rights; shipping happens only through the pipeline. Personal
# gcloud identities make access individually auditable and revocable (remove
# the email from developer_emails and re-apply). Empty var.developer_emails
# (the default) makes both locals below empty maps, so this block is a
# true no-op until real emails are supplied.

locals {
  developer_project_roles = [
    "roles/cloudsql.client",
    "roles/artifactregistry.reader",
    "roles/run.viewer",
    "roles/logging.viewer",
  ]

  developer_role_grants = {
    for pair in setproduct(var.developer_emails, local.developer_project_roles) :
    "${pair[0]}|${pair[1]}" => {
      email = pair[0]
      role  = pair[1]
    }
  }

  developer_secret_grants = {
    for pair in setproduct(var.developer_emails, var.secret_ids) :
    "${pair[0]}|${pair[1]}" => {
      email     = pair[0]
      secret_id = pair[1]
    }
  }
}

resource "google_project_iam_member" "developer" {
  for_each = local.developer_role_grants

  project = var.project_id
  role    = each.value.role
  member  = "user:${each.value.email}"
}

resource "google_secret_manager_secret_iam_member" "developer_secret_accessor" {
  for_each = local.developer_secret_grants

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "user:${each.value.email}"
}

# --- Developer team: group-based human read access --------------------------
# Same access shape as the per-email grants above, but via a Google Group —
# the repo is public, so individual emails must not reach CI/CD logs. The
# transition to group-only access is a tfvars change (set developer_group,
# empty out developer_emails), not a code change; both mechanisms can run
# side by side during the switch. Empty var.developer_group (the default)
# makes both locals below empty maps, so this block is a true no-op until a
# real group email is supplied.

locals {
  developer_group_role_grants = var.developer_group == "" ? {} : {
    for role in local.developer_project_roles :
    role => role
  }

  developer_group_secret_grants = var.developer_group == "" ? {} : {
    for secret_id in var.secret_ids :
    secret_id => secret_id
  }
}

resource "google_project_iam_member" "developer_group" {
  for_each = local.developer_group_role_grants

  project = var.project_id
  role    = each.value
  member  = "group:${var.developer_group}"
}

resource "google_secret_manager_secret_iam_member" "developer_group_secret_accessor" {
  for_each = local.developer_group_secret_grants

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "group:${var.developer_group}"
}
