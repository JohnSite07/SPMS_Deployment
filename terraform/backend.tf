# Remote state backend (GCS). Intentionally an empty partial configuration:
# the bucket/prefix are project-derived values and must not be committed.
# Supply them at init time via the untracked backend.hcl, e.g.:
#   terraform -chdir=terraform init -backend-config=backend.hcl
terraform {
  backend "gcs" {}
}
