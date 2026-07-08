# The three non-sensitive values GitHub Actions needs as repo variables
# (GCP_PROJECT_ID, WIF_PROVIDER, DEPLOYER_SA) for keyless CI/CD — PRD 0005
# wires these into the workflows.

output "gcp_project_id" {
  description = "GCP project ID — GitHub Actions variable GCP_PROJECT_ID."
  value       = var.project_id
}

output "wif_provider" {
  description = "Full Workload Identity Pool provider resource name — GitHub Actions variable WIF_PROVIDER."
  value       = module.iam.wif_provider_name
}

output "deployer_sa_email" {
  description = "Deployer service account email — GitHub Actions variable DEPLOYER_SA."
  value       = module.iam.deployer_sa_email
}
