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
