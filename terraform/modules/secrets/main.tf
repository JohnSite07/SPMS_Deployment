# secrets module — single purpose: the 6 Secret Manager secrets the app
# needs (DB creds, JWT signing key, AES encryption key, SMTP creds). Secret
# material is generated or referenced here, never hard-coded — nothing here
# is committed as plaintext.

# NOTE: hashicorp/random has no "exclude ambiguous characters" (0/O, 1/l/I)
# option — override_special only restricts the symbol set. Length 32 with all
# character classes enabled gives ample entropy despite the occasional
# ambiguous character; flagged for awareness, not a blocker.
resource "random_password" "db" {
  length           = var.db_password_length
  special          = true
  override_special = "!#%&*-_=+?"
  min_upper        = 1
  min_lower        = 1
  min_numeric      = 1
  min_special      = 1
}

resource "google_secret_manager_secret" "db_user" {
  project   = var.project_id
  secret_id = "db-user"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "db_user" {
  secret      = google_secret_manager_secret.db_user.id
  secret_data = var.db_user_name
}

resource "google_secret_manager_secret" "db_password" {
  project   = var.project_id
  secret_id = "db-password"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "db_password" {
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.db.result
}

# --- JWT signing key --------------------------------------------------
resource "random_password" "jwt" {
  length           = var.jwt_signing_key_length
  special          = true
  override_special = "!#%&*-_=+?"
  min_upper        = 1
  min_lower        = 1
  min_numeric      = 1
  min_special      = 1
}

resource "google_secret_manager_secret" "jwt_signing_key" {
  project   = var.project_id
  secret_id = "jwt-signing-key"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "jwt_signing_key" {
  secret      = google_secret_manager_secret.jwt_signing_key.id
  secret_data = random_password.jwt.result
}

# --- AES-256 application encryption key --------------------------------
# random_bytes (not random_password) — this is a raw key, not a typed
# password, so base64-encoded cryptographic bytes are the correct shape.
resource "random_bytes" "aes" {
  length = var.aes_key_bytes
}

resource "google_secret_manager_secret" "aes_encryption_key" {
  project   = var.project_id
  secret_id = "aes-encryption-key"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "aes_encryption_key" {
  secret      = google_secret_manager_secret.aes_encryption_key.id
  secret_data = random_bytes.aes.base64
}

# --- SMTP credentials (placeholders) ------------------------------------
# Real values pending the Developer team's SMTP provider choice. Rotation is
# add-a-version via `gcloud secrets versions add` — no code redeploy needed.
resource "google_secret_manager_secret" "smtp_username" {
  project   = var.project_id
  secret_id = "smtp-username"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "smtp_username" {
  secret      = google_secret_manager_secret.smtp_username.id
  secret_data = var.smtp_placeholder_value
}

resource "google_secret_manager_secret" "smtp_password" {
  project   = var.project_id
  secret_id = "smtp-password"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "smtp_password" {
  secret      = google_secret_manager_secret.smtp_password.id
  secret_data = var.smtp_placeholder_value
}
