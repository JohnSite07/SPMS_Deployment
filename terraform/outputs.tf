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

output "service_url" {
  description = "Public HTTPS URL of the Cloud Run service."
  value       = module.app.service_url
}

output "artifact_registry_repo" {
  description = "Artifact Registry Docker push/pull endpoint CD builds/pushes SHA-tagged images to."
  value       = module.app.artifact_registry_repository_url
}

output "document_bucket_name" {
  description = "Cloud Storage bucket holding encrypted document blobs — used by the SecureDocument feature (PRD 0024/0025) and the storage smoke test."
  value       = module.data.document_bucket_name
}
