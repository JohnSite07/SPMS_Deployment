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
