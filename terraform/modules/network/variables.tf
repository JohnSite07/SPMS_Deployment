variable "project_id" {
  description = "GCP project ID to create network resources in."
  type        = string
}

variable "region" {
  description = "Region for the regional subnet."
  type        = string
}

variable "network_name" {
  description = "Name of the custom-mode VPC."
  type        = string
  default     = "spms-vpc"
}

variable "subnet_name" {
  description = "Name of the regional subnet used for Cloud Run Direct VPC egress."
  type        = string
  default     = "spms-subnet"
}

variable "subnet_cidr" {
  description = "CIDR range for the regional subnet."
  type        = string
  default     = "10.10.0.0/24"
}

variable "psa_range_name" {
  description = "Name of the reserved global address range used for Private Services Access (VPC peering) to Cloud SQL."
  type        = string
  default     = "spms-psa-range"
}

variable "psa_address" {
  description = "Starting address of the reserved PSA range."
  type        = string
  default     = "10.20.0.0"
}

variable "psa_prefix_length" {
  description = "Prefix length of the reserved PSA range (a /16 gives Google's managed services room to allocate)."
  type        = number
  default     = 16
}
