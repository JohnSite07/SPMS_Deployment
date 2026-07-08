variable "project_id" {
  description = "GCP project ID to create IAM resources in."
  type        = string
}

variable "runtime_sa_account_id" {
  description = "Account ID (local part, before @) of the Cloud Run runtime service account."
  type        = string
  default     = "spms-runtime"
}

variable "deployer_sa_account_id" {
  description = "Account ID (local part, before @) of the CI/CD deployer service account."
  type        = string
  default     = "spms-deployer"
}

variable "secret_ids" {
  description = "Secret Manager secret IDs the runtime SA needs roles/secretmanager.secretAccessor on, granted per-secret (never project-wide). More arrive in PRD 0004 (JWT/AES/SMTP)."
  type        = list(string)
}

variable "document_bucket_name" {
  description = "Name of the document Cloud Storage bucket the runtime SA needs roles/storage.objectAdmin on, scoped to this bucket only."
  type        = string
}

variable "wif_pool_id" {
  description = "Workload Identity Pool ID."
  type        = string
  default     = "spms-pool"
}

variable "wif_provider_id" {
  description = "Workload Identity Pool provider ID."
  type        = string
  default     = "github"
}

variable "github_repository" {
  description = "GitHub \"owner/repo\" allowed to authenticate via WIF and impersonate the deployer SA. The WIF provider's attribute_condition pins to exactly this repository — no other repo can exchange tokens through this pool."
  type        = string
  default     = "JohnSite07/SPMS_Deployment"
}

variable "billing_account_id" {
  description = "Billing account the budget lives on; deployer needs costsManager there to manage it via terraform apply."
  type        = string
}

variable "developer_emails" {
  description = "Google account emails of Developer-team members granted read-only human access (Cloud SQL client, Artifact Registry reader, Cloud Run viewer, logging viewer, per-secret secretAccessor across all secret_ids). Default empty — access is added by supplying real emails via tfvars; an empty list creates zero resources, so committing this is a no-op until then. Revoke access by removing an email and re-applying."
  type        = list(string)
  default     = []
}

variable "developer_group" {
  description = "Google Group email granted the same read-only Developer-team access shape as developer_emails (group:<email> members instead of per-person user:<email>) — avoids personal emails reaching a public repo's CI/CD logs. Default empty string creates zero resources; going live is a tfvars change (set this, then empty out developer_emails), not a code change."
  type        = string
  default     = ""
}
