variable "project_id" {
  description = "GCP project ID to create secrets in."
  type        = string
}

variable "db_user_name" {
  description = "Cloud SQL application login username, stored as the db-user secret value."
  type        = string
  default     = "spms_app"
}

variable "db_password_length" {
  description = "Length of the generated Cloud SQL application password."
  type        = number
  default     = 32
}
