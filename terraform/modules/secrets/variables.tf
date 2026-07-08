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

variable "jwt_signing_key_length" {
  description = "Length of the generated JWT signing key."
  type        = number
  default     = 64
}

variable "aes_key_bytes" {
  description = "Length in bytes of the generated AES encryption key (32 bytes = AES-256)."
  type        = number
  default     = 32
}

variable "smtp_placeholder_value" {
  description = "Placeholder secret value for smtp-username/smtp-password until the Developer team picks an SMTP provider. Rotate by adding a new secret version — no code redeploy needed."
  type        = string
  default     = "PLACEHOLDER-set-real-value-via-rotation"
}
