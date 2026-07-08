output "db_user_secret_id" {
  description = "Secret Manager secret ID holding the Cloud SQL application username."
  value       = google_secret_manager_secret.db_user.secret_id
}

output "db_password_secret_id" {
  description = "Secret Manager secret ID holding the Cloud SQL application password."
  value       = google_secret_manager_secret.db_password.secret_id
}

output "db_user_name" {
  description = "Cloud SQL application username (not sensitive on its own)."
  value       = var.db_user_name
}

output "db_password" {
  description = "Generated Cloud SQL application password — sensitive, consumed only by the data module to create the SQL user."
  value       = random_password.db.result
  sensitive   = true
}
