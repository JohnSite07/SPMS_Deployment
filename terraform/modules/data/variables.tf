variable "project_id" {
  description = "GCP project ID to create data resources in."
  type        = string
}

variable "region" {
  description = "Region for the Cloud SQL instance."
  type        = string
}

variable "network_id" {
  description = "VPC network ID (from the network module) that the Cloud SQL instance peers into via Private Services Access."
  type        = string
}

variable "instance_name" {
  description = "Cloud SQL instance name."
  type        = string
  default     = "spms-mysql"
}

variable "database_version" {
  # MYSQL_8_4 requires the Enterprise Plus edition, whose smallest tiers cost
  # hundreds/month — incompatible with db-f1-micro and the $300 budget.
  # MySQL 8.0 on the Enterprise edition keeps the designed cost profile.
  description = "Cloud SQL MySQL version."
  type        = string
  default     = "MYSQL_8_0"
}

variable "tier" {
  description = "Cloud SQL machine tier. db-f1-micro is the smallest shared-core tier — keep cost minimal per design."
  type        = string
  default     = "db-f1-micro"
}

variable "disk_size_gb" {
  description = "Cloud SQL data disk size in GB."
  type        = number
  default     = 10
}

variable "deletion_protection" {
  description = "Whether to block terraform destroy on the SQL instance. Deliberately false — this is a disposable environment that must tear down cleanly."
  type        = bool
  default     = false
}

variable "database_name" {
  description = "Application schema name."
  type        = string
  default     = "securevault"
}

variable "db_user_name" {
  description = "Application login username (from the secrets module)."
  type        = string
}

variable "db_password" {
  description = "Application login password (from the secrets module) — sensitive, never logged or output in plaintext."
  type        = string
  sensitive   = true
}

variable "document_bucket_suffix" {
  description = "Suffix appended to the project ID to name the document bucket."
  type        = string
  default     = "spms-documents"
}

variable "document_retention_days" {
  description = "Age (days) after which document objects are deleted by the lifecycle rule."
  type        = number
  default     = 365
}
