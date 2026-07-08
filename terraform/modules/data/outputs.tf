output "private_ip_address" {
  description = "Private IP address of the Cloud SQL instance (no public IP is assigned)."
  value       = google_sql_database_instance.mysql.private_ip_address
}

output "instance_connection_name" {
  description = "Cloud SQL instance connection name (project:region:instance)."
  value       = google_sql_database_instance.mysql.connection_name
}

output "database_name" {
  description = "Application schema name."
  value       = google_sql_database.app.name
}

output "user_name" {
  description = "Application login username."
  value       = google_sql_user.app.name
}

output "document_bucket_name" {
  description = "Name of the Cloud Storage bucket holding encrypted document blobs."
  value       = google_storage_bucket.documents.name
}
