variable "project_id" {
  description = "GCP project ID that hosts the SecureVault (SPMS) infrastructure."
  type        = string
}

variable "region" {
  description = "GCP region for all resources. Default is us-central1 (Tier-1 pricing, free-tier eligible); switch to northamerica-northeast1 for Canadian data residency."
  type        = string
  default     = "us-central1"
}

variable "billing_account_id" {
  description = "Billing account ID the project is linked to, used to scope the $300 budget alert. Supplied via terraform.tfvars — never committed."
  type        = string
}

variable "github_repository" {
  description = "GitHub \"owner/repo\" allowed to authenticate via Workload Identity Federation and impersonate the deployer service account. The WIF provider's attribute_condition pins to exactly this repository."
  type        = string
  default     = "JohnSite07/SPMS_Deployment"
}

variable "developer_emails" {
  description = "Google account emails of Developer-team members granted read-only human access. Default empty — the team's emails arrive later via tfvars; an empty list is a no-op (creates zero resources)."
  type        = list(string)
  default     = []
}
