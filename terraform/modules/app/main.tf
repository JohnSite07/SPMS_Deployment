# app module — single purpose: Cloud Run service (min=0/max=2, Direct VPC
# egress) and Artifact Registry repo for the SPMS container image.

resource "google_artifact_registry_repository" "spms" {
  project       = var.project_id
  location      = var.region
  repository_id = var.repository_id
  format        = "DOCKER"
  description   = "SPMS SecureVault container images, tagged by git commit SHA."

  # Keep the most recent N versions; delete everything else. Prevents
  # unbounded image-storage cost creep.
  cleanup_policies {
    id     = "keep-minimum-versions"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.ar_cleanup_keep_count
    }
  }

  cleanup_policies {
    id     = "delete-older-versions"
    action = "DELETE"
    condition {
      tag_state = "ANY"
    }
  }
}

resource "google_cloud_run_v2_service" "spms" {
  project             = var.project_id
  name                = var.service_name
  location            = var.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL" # public web app

  template {
    service_account = var.runtime_sa_email

    scaling {
      min_instance_count = var.demo_min_instances
      max_instance_count = var.max_instance_count
    }

    # Direct VPC egress — deliberately not a Serverless VPC Access connector
    # (that would be an always-on cost). PRIVATE_RANGES_ONLY keeps public
    # internet egress off the VPC path.
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = var.network_id
        subnetwork = var.subnet_id
      }
    }

    containers {
      image = var.initial_image

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
      }

      # --- Plain env vars ---
      env {
        name  = "DB_HOST"
        value = var.db_host
      }
      env {
        name  = "DB_PORT"
        value = var.db_port
      }
      env {
        name  = "DB_NAME"
        value = var.db_name
      }
      env {
        name  = "DB_USER"
        value = var.db_user_name
      }
      env {
        name  = "DOCUMENTS_BUCKET"
        value = var.documents_bucket_name
      }

      # --- Secret-backed env vars (never literal values) ---
      env {
        name = "DB_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = var.db_password_secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "JWT_SIGNING_KEY"
        value_source {
          secret_key_ref {
            secret  = var.jwt_signing_key_secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "AES_ENCRYPTION_KEY"
        value_source {
          secret_key_ref {
            secret  = var.aes_encryption_key_secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "SMTP_USERNAME"
        value_source {
          secret_key_ref {
            secret  = var.smtp_username_secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "SMTP_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = var.smtp_password_secret_id
            version = "latest"
          }
        }
      }
    }
  }

  # CD deploys new revisions by SHA-tagged image (and sets client/client_version
  # via gcloud/gh actions) — Terraform must not fight those out-of-band changes.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }
}

# Public web app — anyone can invoke the service.
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  project  = var.project_id
  location = google_cloud_run_v2_service.spms.location
  name     = google_cloud_run_v2_service.spms.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
