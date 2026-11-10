resource "google_service_account" "deployer" {
  account_id   = "${var.name}-deploy"
  display_name = "GitHub Actions image deployment only"
  depends_on   = [google_project_service.enabled]
}
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "${var.name}-github"
  display_name              = "SubKit Analytics GitHub"
  depends_on                = [google_project_service.enabled]
}
resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.ref"                 = "assertion.ref"
    "attribute.workflow_ref"        = "assertion.workflow_ref"
  }
  attribute_condition = "assertion.repository_id == '${var.github_repository_id}' && assertion.repository_owner_id == '${var.github_owner_id}' && assertion.ref == 'refs/heads/${var.github_branch}' && assertion.workflow_ref == '${var.github_repository}/.github/workflows/deploy.yml@refs/heads/${var.github_branch}' && assertion.sub == 'repo:${var.github_repository}:environment:${var.github_environment}'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}
resource "google_service_account_iam_member" "github" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/${var.github_repository_id}"
}
resource "google_artifact_registry_repository_iam_member" "deployer" {
  location   = var.region
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}
resource "google_service_account_iam_member" "deploy_runtime" {
  for_each           = local.runtime
  service_account_id = google_service_account.runtime[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
resource "google_cloud_run_v2_service_iam_member" "deploy_api" {
  count    = var.deploy_services ? 1 : 0
  name     = google_cloud_run_v2_service.api[0].name
  location = var.region
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deployer.email}"
}
resource "google_cloud_run_v2_service_iam_member" "deploy_worker" {
  count    = var.deploy_services ? 1 : 0
  name     = google_cloud_run_v2_service.worker[0].name
  location = var.region
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deployer.email}"
}
resource "google_cloud_run_v2_job_iam_member" "deploy_migration" {
  count    = var.deploy_services || var.deploy_jobs ? 1 : 0
  name     = google_cloud_run_v2_job.migrate[0].name
  location = var.region
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deployer.email}"
}
resource "google_cloud_run_v2_job_iam_member" "deploy_kms_check" {
  for_each = var.deploy_services || var.deploy_jobs ? toset(["api", "worker"]) : toset([])
  name     = google_cloud_run_v2_job.kms_check[each.key].name
  location = var.region
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deployer.email}"
}
