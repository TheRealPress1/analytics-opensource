mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
}
variables {
  project_id           = "synthetic-analytics-test"
  github_repository    = "synthetic-org/analytics"
  github_repository_id = "123456789"
  github_owner_id      = "987654321"
  notification_email   = "ops@example.com"
  billing_account_id   = "000000-000000-000000"
}
run "foundation_is_private" {
  command = plan
  assert {
    condition     = google_sql_database_instance.main.settings[0].ip_configuration[0].ipv4_enabled == false
    error_message = "Cloud SQL must not expose a public IP."
  }
  assert {
    condition     = google_sql_database_instance.main.database_version == "POSTGRES_16" && google_sql_database_instance.main.settings[0].backup_configuration[0].point_in_time_recovery_enabled
    error_message = "Postgres 16 and PITR are required."
  }
  assert {
    condition     = google_kms_crypto_key.credentials.rotation_period == "7776000s" && length(google_kms_crypto_key_iam_member.runtime) == 2
    error_message = "Both runtime identities need key-scoped KMS access and 90-day rotation."
  }
  assert {
    condition     = length(google_pubsub_topic.events) == 0 && length(google_cloud_run_v2_service.api) == 0
    error_message = "Bootstrap must not start services or unused Pub/Sub."
  }
  assert {
    condition     = google_billing_budget.project[0].amount[0].specified_amount[0].units == "50"
    error_message = "The default budget alert must be 50 USD."
  }
  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.repository_id == '123456789'") && strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.repository_owner_id == '987654321'") && strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "environment:staging")
    error_message = "OIDC must bind immutable repo/owner IDs and the deployment environment."
  }
}
run "services_are_restricted" {
  command = plan
  variables {
    deploy_services = true
    api_image       = "us-east4-docker.pkg.dev/synthetic-analytics-test/subkit-analytics/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    worker_image    = "us-east4-docker.pkg.dev/synthetic-analytics-test/subkit-analytics/worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
  assert {
    condition     = google_cloud_run_v2_service.api[0].template[0].scaling[0].min_instance_count == 1 && google_cloud_run_v2_service.worker[0].template[0].scaling[0].min_instance_count == 1
    error_message = "Both API and worker require minimum one instance."
  }
  assert {
    condition     = !google_cloud_run_v2_service.worker[0].template[0].containers[0].resources[0].cpu_idle && google_cloud_run_v2_service.worker[0].template[0].scaling[0].min_instance_count == 1
    error_message = "Worker CPU must stay allocated with at least one instance."
  }
  assert {
    condition     = google_cloud_run_v2_service.worker[0].template[0].timeout == "30s" && google_cloud_run_v2_service.worker[0].template[0].max_instance_request_concurrency == 80 && google_cloud_run_v2_service.worker[0].ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY"
    error_message = "Worker must use internal ingress, concurrency 80 and 30-second timeout."
  }
  assert {
    condition     = length(google_cloud_run_v2_service.worker[0].template[0].volumes) == 0 && length(google_cloud_run_v2_service.api[0].template[0].volumes) == 1
    error_message = "Worker needs no secret access; API reads one signing secret file."
  }
  assert {
    condition     = length(google_cloud_run_v2_job.kms_check) == 2
    error_message = "Both runtime service identities need staging KMS acceptance jobs."
  }
}
run "jobs_can_bootstrap_before_services" {
  command = plan
  variables {
    deploy_jobs = true
    api_image   = "us-east4-docker.pkg.dev/synthetic-analytics-test/subkit-analytics/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition     = length(google_cloud_run_v2_job.migrate) == 1 && length(google_cloud_run_v2_service.api) == 0
    error_message = "Migrations must be deployable before a first service startup."
  }
}
