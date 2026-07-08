output "service_url" {
  description = "Public HTTPS URL of the Cloud Run service."
  value       = google_cloud_run_v2_service.spms.uri
}

output "service_name" {
  description = "Cloud Run service name."
  value       = google_cloud_run_v2_service.spms.name
}

output "artifact_registry_repository_id" {
  description = "Artifact Registry repository ID."
  value       = google_artifact_registry_repository.spms.repository_id
}

output "artifact_registry_repository_url" {
  description = "Artifact Registry Docker push/pull endpoint, e.g. us-central1-docker.pkg.dev/<project>/spms — what CD's docker buildx push target uses."
  value       = google_artifact_registry_repository.spms.registry_uri
}
