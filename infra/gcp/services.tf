resource "google_cloud_run_v2_service" "api" {
  count               = var.deploy_services ? 1 : 0
  name                = "${var.name}-api"
  location            = var.region
  deletion_protection = true
  ingress             = "INGRESS_TRAFFIC_ALL"
  template {
    service_account                  = google_service_account.runtime["api"].email
    timeout                          = "30s"
    max_instance_request_concurrency = 80
    scaling {
      min_instance_count = 1
      max_instance_count = 5
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.main.name
        subnetwork = google_compute_subnetwork.run.name
      }
    }
    volumes {
      name = "token-signing"
      secret {
        secret = google_secret_manager_secret.runtime["token-signing"].secret_id
        items {
          version = var.token_secret_version
          path    = "value"
        }
      }
    }
    containers {
      image = var.api_image
      ports {
        container_port = 8080
      }
      resources {
        limits = {
          cpu    = "1",
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = local.database_env
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name  = "DB_USER"
        value = google_sql_user.runtime["api"].name
      }
      env {
        name  = "SUBKIT_TOKEN_SECRET_FILE"
        value = "/var/run/secrets/token/value"
      }
      env {
        name  = "SUBKIT_KMS_KEY_NAME"
        value = google_kms_crypto_key.credentials.id
      }
      volume_mounts {
        name       = "token-signing"
        mount_path = "/var/run/secrets/token"
      }
      startup_probe {
        http_get {
          path = "/readyz"
          port = 8080
        }
        initial_delay_seconds = 0
        timeout_seconds       = 5
        period_seconds        = 10
        failure_threshold     = 12
      }
      liveness_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        timeout_seconds   = 3
        period_seconds    = 30
        failure_threshold = 3
      }
    }
  }
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
    precondition {
      condition     = can(regex("@sha256:[a-f0-9]{64}$", var.api_image))
      error_message = "Provide an immutable API image digest before enabling services."
    }
  }
  depends_on = [google_project_iam_member.sql, google_secret_manager_secret_iam_member.api_token]
}
# Public HTTP transport is required by mobile SDKs. Every collector and server
# route still verifies its own scoped token; health endpoints contain no data.
resource "google_cloud_run_v2_service_iam_member" "api_public" {
  count    = var.deploy_services ? 1 : 0
  name     = google_cloud_run_v2_service.api[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
resource "google_cloud_run_v2_service" "worker" {
  count               = var.deploy_services ? 1 : 0
  name                = "${var.name}-worker"
  location            = var.region
  deletion_protection = true
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  template {
    service_account                  = google_service_account.runtime["worker"].email
    timeout                          = "30s"
    max_instance_request_concurrency = 80
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.main.name
        subnetwork = google_compute_subnetwork.run.name
      }
    }
    containers {
      image = var.worker_image
      ports {
        container_port = 8080
      }
      resources {
        limits = {
          cpu    = "1",
          memory = "512Mi"
        }
        cpu_idle          = false
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = local.database_env
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name  = "DB_USER"
        value = google_sql_user.runtime["worker"].name
      }
      env {
        name  = "SUBKIT_KMS_KEY_NAME"
        value = google_kms_crypto_key.credentials.id
      }
      startup_probe {
        http_get {
          path = "/readyz"
          port = 8080
        }
        initial_delay_seconds = 0
        timeout_seconds       = 5
        period_seconds        = 10
        failure_threshold     = 12
      }
      liveness_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        timeout_seconds   = 3
        period_seconds    = 30
        failure_threshold = 3
      }
    }
  }
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
    precondition {
      condition     = can(regex("@sha256:[a-f0-9]{64}$", var.worker_image))
      error_message = "Provide an immutable worker image digest before enabling services."
    }
  }
  depends_on = [google_project_iam_member.sql]
}
resource "google_cloud_run_v2_job" "migrate" {
  count               = var.deploy_services || var.deploy_jobs ? 1 : 0
  name                = "${var.name}-migrate"
  location            = var.region
  deletion_protection = true
  template {
    task_count  = 1
    parallelism = 1
    template {
      service_account = google_service_account.runtime["migrate"].email
      max_retries     = 0
      timeout         = "600s"
      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.main.name
          subnetwork = google_compute_subnetwork.run.name
        }
      }
      containers {
        image   = var.api_image
        command = ["node"]
        args    = ["packages/db/dist/migrate.js"]
        resources {
          limits = {
            cpu    = "1",
            memory = "512Mi"
          }
        }
        dynamic "env" {
          for_each = local.database_env
          content {
            name  = env.key
            value = env.value
          }
        }
        env {
          name  = "DB_USER"
          value = google_sql_user.runtime["migrate"].name
        }
      }
    }
  }
  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image]
  }
  depends_on = [google_project_iam_member.sql]
}
resource "google_cloud_run_v2_job" "kms_check" {
  for_each            = var.deploy_services || var.deploy_jobs ? toset(["api", "worker"]) : toset([])
  name                = "${var.name}-kms-${each.key}"
  location            = var.region
  deletion_protection = true
  template {
    task_count  = 1
    parallelism = 1
    template {
      service_account = google_service_account.runtime[each.key].email
      max_retries     = 0
      timeout         = "60s"
      containers {
        image   = var.api_image
        command = ["node"]
        args    = ["packages/crypto/dist/smoke.js"]
        resources {
          limits = { cpu = "1", memory = "512Mi" }
        }
        env {
          name  = "SUBKIT_KMS_KEY_NAME"
          value = google_kms_crypto_key.credentials.id
        }
      }
    }
  }
  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image]
    precondition {
      condition     = can(regex("@sha256:[a-f0-9]{64}$", var.api_image))
      error_message = "Provide an immutable API image digest before enabling jobs."
    }
  }
  depends_on = [google_kms_crypto_key_iam_member.runtime]
}
