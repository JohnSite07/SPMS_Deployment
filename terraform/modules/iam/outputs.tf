output "runtime_sa_email" {
  description = "Email of the Cloud Run runtime service account — module.app will need this in a later PRD."
  value       = google_service_account.runtime.email
}

output "deployer_sa_email" {
  description = "Email of the CI/CD deployer service account — one of the three GitHub Actions variable values."
  value       = google_service_account.deployer.email
}

output "wif_pool_name" {
  description = "Full resource name of the Workload Identity Pool (projects/{number}/locations/global/workloadIdentityPools/{id})."
  value       = google_iam_workload_identity_pool.pool.name
}

output "wif_provider_name" {
  description = "Full resource name of the Workload Identity Pool provider — the GitHub Actions WIF_PROVIDER variable value."
  value       = google_iam_workload_identity_pool_provider.github.name
}
