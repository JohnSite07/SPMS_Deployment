variable "project_id" {
  description = "GCP project ID to create app resources in."
  type        = string
}

variable "region" {
  description = "Region for Artifact Registry and Cloud Run."
  type        = string
}

variable "service_name" {
  description = "Cloud Run service name."
  type        = string
  default     = "spms"
}

variable "repository_id" {
  description = "Artifact Registry repository ID."
  type        = string
  default     = "spms"
}

variable "ar_cleanup_keep_count" {
  description = "Number of most-recent image versions Artifact Registry keeps; older versions are deleted by the cleanup policy."
  type        = number
  default     = 10
}

variable "runtime_sa_email" {
  description = "Email of the Cloud Run runtime service account (from the iam module)."
  type        = string
}

variable "network_id" {
  description = "VPC network ID (from the network module) for Direct VPC egress."
  type        = string
}

variable "subnet_id" {
  description = "Regional subnet ID (from the network module) for Direct VPC egress."
  type        = string
}

variable "demo_min_instances" {
  description = "Minimum Cloud Run instance count. Default 0 (scale-to-zero); a >0 value is a documented, temporary demo-window override only — never the default per the cost design."
  type        = number
  default     = 0
}

variable "max_instance_count" {
  description = "Maximum Cloud Run instance count."
  type        = number
  default     = 2
}

variable "cpu" {
  description = "vCPU limit per container instance."
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory limit per container instance."
  type        = string
  default     = "512Mi"
}

variable "initial_image" {
  description = "Initial container image. The real image is deployed by CD via commit-SHA tags; this default is ignored after the first apply (see lifecycle.ignore_changes)."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

# --- Env contract: plain values ------------------------------------------

variable "db_host" {
  description = "Cloud SQL private IP address — env DB_HOST."
  type        = string
}

variable "db_port" {
  description = "Cloud SQL port — env DB_PORT."
  type        = string
  default     = "3306"
}

variable "db_name" {
  description = "Application schema name — env DB_NAME."
  type        = string
}

variable "db_user_name" {
  description = "Application login username — env DB_USER."
  type        = string
}

variable "documents_bucket_name" {
  description = "Document Cloud Storage bucket name — env DOCUMENTS_BUCKET."
  type        = string
}

# --- Env contract: secret references (env.value_source.secret_key_ref) ---

variable "db_password_secret_id" {
  description = "Secret Manager secret ID for the DB password — env DB_PASSWORD."
  type        = string
}

variable "jwt_signing_key_secret_id" {
  description = "Secret Manager secret ID for the JWT signing key — env JWT_SIGNING_KEY."
  type        = string
}

variable "aes_encryption_key_secret_id" {
  description = "Secret Manager secret ID for the AES encryption key — env AES_ENCRYPTION_KEY."
  type        = string
}

variable "smtp_username_secret_id" {
  description = "Secret Manager secret ID for the SMTP username — env SMTP_USERNAME."
  type        = string
}

variable "smtp_password_secret_id" {
  description = "Secret Manager secret ID for the SMTP password — env SMTP_PASSWORD."
  type        = string
}
