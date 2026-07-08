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

output "jwt_signing_key_secret_id" {
  description = "Secret Manager secret ID holding the JWT signing key."
  value       = google_secret_manager_secret.jwt_signing_key.secret_id
}

output "aes_encryption_key_secret_id" {
  description = "Secret Manager secret ID holding the AES-256 application encryption key."
  value       = google_secret_manager_secret.aes_encryption_key.secret_id
}

output "smtp_username_secret_id" {
  description = "Secret Manager secret ID holding the SMTP username (placeholder value pending Developer team's SMTP provider choice)."
  value       = google_secret_manager_secret.smtp_username.secret_id
}

output "smtp_password_secret_id" {
  description = "Secret Manager secret ID holding the SMTP password (placeholder value pending Developer team's SMTP provider choice)."
  value       = google_secret_manager_secret.smtp_password.secret_id
}

output "all_secret_ids" {
  description = "All 6 secret IDs, for wiring the runtime SA's per-secret secretAccessor grants in the iam module."
  value = [
    google_secret_manager_secret.db_user.secret_id,
    google_secret_manager_secret.db_password.secret_id,
    google_secret_manager_secret.jwt_signing_key.secret_id,
    google_secret_manager_secret.aes_encryption_key.secret_id,
    google_secret_manager_secret.smtp_username.secret_id,
    google_secret_manager_secret.smtp_password.secret_id,
  ]
}
