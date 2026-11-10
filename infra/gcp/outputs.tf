output "instance_connection_name" {
  value = google_sql_database_instance.main.connection_name
}
output "database_users" {
  value = {
    for role, account in google_sql_user.runtime : role => account.name
  }
}
output "runtime_service_accounts" {
  value = {
    for role, account in google_service_account.runtime : role => account.email
  }
}
output "kms_key_name" {
  value = google_kms_crypto_key.credentials.id
}
output "secret_names" {
  value = {
    for key, secret in google_secret_manager_secret.runtime : key => secret.secret_id
  }
}
output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}
output "workload_identity_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}
output "deployment_service_account" {
  value = google_service_account.deployer.email
}
output "api_url" {
  value = try(google_cloud_run_v2_service.api[0].uri, null)
}
output "worker_url" {
  value = try(google_cloud_run_v2_service.worker[0].uri, null)
}
output "migration_job" {
  value = try(google_cloud_run_v2_job.migrate[0].name, null)
}
output "budget_configured" {
  value = length(google_billing_budget.project) > 0
}
