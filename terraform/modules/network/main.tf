# network module — single purpose: VPC + Direct VPC egress plumbing for
# Cloud Run to reach Cloud SQL over private IP (no Serverless VPC connector).

resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = var.network_name
  auto_create_subnetworks = false
}

# Single regional subnet — Cloud Run reaches it via Direct VPC egress
# (no Serverless VPC Access connector, which would be an always-on cost).
resource "google_compute_subnetwork" "subnet" {
  project                  = var.project_id
  name                     = var.subnet_name
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
}

# Private Services Access: a reserved /16 range that Google's managed
# services (Cloud SQL) peer into, so the SQL instance gets a private IP
# on this VPC instead of a public one.
resource "google_compute_global_address" "psa_range" {
  project       = var.project_id
  name          = var.psa_range_name
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  address       = var.psa_address
  prefix_length = var.psa_prefix_length
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa_range.name]
}
