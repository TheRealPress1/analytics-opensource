locals {
  services = toset([
    "run.googleapis.com", "sqladmin.googleapis.com", "compute.googleapis.com", "servicenetworking.googleapis.com",
    "artifactregistry.googleapis.com", "secretmanager.googleapis.com", "cloudkms.googleapis.com", "iam.googleapis.com",
    "iamcredentials.googleapis.com", "sts.googleapis.com", "logging.googleapis.com", "monitoring.googleapis.com",
    "billingbudgets.googleapis.com", "pubsub.googleapis.com",
  ])
  runtime = toset(["api", "worker", "migrate"])
  sql_roles = {
    for pair in setproduct(local.runtime, toset(["roles/cloudsql.client", "roles/cloudsql.instanceUser"])) : "${pair[0]}-${replace(pair[1], "/", "-")}" => {
      identity = pair[0],
      role     = pair[1]
    }
  }
  database_env = {
    INSTANCE_CONNECTION_NAME = google_sql_database_instance.main.connection_name,
    DB_NAME                  = var.db_name,
    NODE_ENV                 = "production"
  }
}
data "google_project" "current" {
  project_id = var.project_id
}
resource "google_project_service" "enabled" {
  for_each           = local.services
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
resource "google_compute_network" "main" {
  name                    = var.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.enabled]
}
resource "google_compute_subnetwork" "run" {
  name                     = "${var.name}-run"
  region                   = var.region
  network                  = google_compute_network.main.id
  ip_cidr_range            = "10.40.0.0/24"
  private_ip_google_access = true
}
resource "google_compute_global_address" "sql" {
  name          = "${var.name}-sql-private"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.main.id
}
resource "google_service_networking_connection" "sql" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql.name]
}
resource "google_service_account" "runtime" {
  for_each     = local.runtime
  account_id   = "${var.name}-${each.key}"
  display_name = "SubKit Analytics ${each.key}"
  depends_on   = [google_project_service.enabled]
}
resource "google_sql_database_instance" "main" {
  name                = "${var.name}-pg"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = true
  settings {
    tier                        = var.db_tier
    edition                     = "ENTERPRISE"
    availability_type           = var.db_availability_type
    disk_type                   = "PD_SSD"
    disk_size                   = 20
    disk_autoresize             = true
    disk_autoresize_limit       = 100
    deletion_protection_enabled = true
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.main.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    backup_configuration {
      enabled                        = true
      start_time                     = "07:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 14
        retention_unit   = "COUNT"
      }
    }
    maintenance_window {
      day          = 7
      hour         = 8
      update_track = "stable"
    }
  }
  depends_on = [google_service_networking_connection.sql]
}
resource "google_sql_database" "main" {
  name     = var.db_name
  instance = google_sql_database_instance.main.name
}
resource "google_sql_user" "runtime" {
  for_each = local.runtime
  name     = trimsuffix(google_service_account.runtime[each.key].email, ".gserviceaccount.com")
  instance = google_sql_database_instance.main.name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}
# Cloud SQL IAM has no per-instance policy resource. A project binding with an exact
# resource condition scopes connect/login to this instance (not all project SQL).
resource "google_project_iam_member" "sql" {
  for_each = local.sql_roles
  project  = var.project_id
  role     = each.value.role
  member   = "serviceAccount:${google_service_account.runtime[each.value.identity].email}"
  condition {
    title      = "only-analytics-instance"
    expression = "resource.type == 'sqladmin.googleapis.com/Instance' && resource.name == 'projects/${var.project_id}/instances/${google_sql_database_instance.main.name}'"
  }
}
resource "google_artifact_registry_repository" "images" {
  repository_id = var.name
  location      = var.region
  format        = "DOCKER"
  description   = "Versioned SubKit Analytics service images"
  depends_on    = [google_project_service.enabled]
}
resource "google_kms_key_ring" "credentials" {
  name       = "subkit"
  location   = var.region
  depends_on = [google_project_service.enabled]
}
resource "google_kms_crypto_key" "credentials" {
  name            = "credentials-kek"
  key_ring        = google_kms_key_ring.credentials.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s"
  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }
  lifecycle {
    prevent_destroy = true
  }
}
resource "google_kms_crypto_key_iam_member" "runtime" {
  for_each      = var.enable_credential_encryption ? toset(["api", "worker"]) : toset([])
  crypto_key_id = google_kms_crypto_key.credentials.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.runtime[each.key].email}"
}
resource "google_secret_manager_secret" "runtime" {
  for_each  = toset(["token-signing", "admin-key"])
  secret_id = "${var.name}-${each.key}"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.enabled]
}
resource "google_secret_manager_secret_iam_member" "api_token" {
  secret_id = google_secret_manager_secret.runtime["token-signing"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime["api"].email}"
}
# No secret version resources or secret-data lookups: payloads never enter state.
resource "google_pubsub_topic" "events" {
  count                      = var.enable_pubsub_foundation ? 1 : 0
  name                       = "${var.name}-events-foundation"
  message_retention_duration = "86400s"
  depends_on                 = [google_project_service.enabled]
}
resource "google_pubsub_topic" "dead_letter" {
  count                      = var.enable_pubsub_foundation ? 1 : 0
  name                       = "${var.name}-dead-letter-foundation"
  message_retention_duration = "604800s"
  depends_on                 = [google_project_service.enabled]
}
