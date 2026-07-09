# data module — single purpose: Cloud SQL (MySQL, db-f1-micro, private IP by
# default; a public IP is a reversible dev-phase toggle, see enable_public_ip)
# plus the app schema and app login, and the document blob bucket.
# Requires the network module's PSA connection to already exist (wired via
# depends_on in the root module block).

resource "google_sql_database_instance" "mysql" {
  project             = var.project_id
  name                = var.instance_name
  region              = var.region
  database_version    = var.database_version
  deletion_protection = var.deletion_protection

  settings {
    tier              = var.tier
    edition           = "ENTERPRISE" # shared-core tiers exist only in this edition
    disk_size         = var.disk_size_gb
    disk_type         = "PD_SSD"
    disk_autoresize   = false # cost guardrail: 10 GB is a hard cap, not a starting point
    availability_type = "ZONAL"

    # Public IP is a reversible dev-phase toggle (var.enable_public_ip,
    # default false). No authorized_networks block is declared, by design:
    # with a public IP and zero authorized networks, direct `mysql -h <ip>`
    # is refused and only IAM-authenticated Cloud SQL Auth Proxy connections
    # work. Do not add authorized_networks — that would break this gate.
    # ssl_mode is deliberately left at its default for the same reason (see
    # variable description) — do not set/change it here.
    ip_configuration {
      ipv4_enabled    = var.enable_public_ip
      private_network = var.network_id
    }

    # MySQL PITR is achieved via binary_log_enabled (point_in_time_recovery_enabled
    # is a Postgres/SQL Server only field and errors out for MySQL instances).
    backup_configuration {
      enabled                        = true
      binary_log_enabled             = true
      start_time                     = "03:00"
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = 7
        retention_unit   = "COUNT"
      }
    }
  }
}

resource "google_sql_database" "app" {
  project  = var.project_id
  name     = var.database_name
  instance = google_sql_database_instance.mysql.name
}

resource "google_sql_user" "app" {
  project  = var.project_id
  name     = var.db_user_name
  instance = google_sql_database_instance.mysql.name
  password = var.db_password
}

# Encrypted document blobs (app-layer AES-256 encryption applies before
# upload). Disposable environment: force_destroy so `terraform destroy`
# removes the bucket even if objects remain inside.
resource "google_storage_bucket" "documents" {
  project                     = var.project_id
  name                        = "${var.project_id}-${var.document_bucket_suffix}"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  versioning {
    enabled = false
  }

  lifecycle_rule {
    condition {
      age = var.document_retention_days
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      age = 7
    }
    action {
      type = "AbortIncompleteMultipartUpload"
    }
  }
}
