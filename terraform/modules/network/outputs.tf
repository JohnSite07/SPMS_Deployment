output "network_id" {
  description = "Resource ID of the VPC (form: projects/{project}/global/networks/{name})."
  value       = google_compute_network.vpc.id
}

output "network_self_link" {
  description = "Self-link of the VPC."
  value       = google_compute_network.vpc.self_link
}

output "subnet_id" {
  description = "Resource ID of the regional subnet."
  value       = google_compute_subnetwork.subnet.id
}

output "subnet_name" {
  description = "Name of the regional subnet."
  value       = google_compute_subnetwork.subnet.name
}
