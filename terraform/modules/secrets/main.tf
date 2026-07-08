# secrets module — single purpose: Secret Manager secrets (DB creds now; JWT
# key, AES key, SMTP creds added by a later PRD). Secret material is generated
# or referenced here, never hard-coded — nothing here is committed as plaintext.

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
