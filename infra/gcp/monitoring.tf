resource "google_project_iam_audit_config" "sensitive_access" {
  for_each = toset(["cloudkms.googleapis.com", "secretmanager.googleapis.com", "cloudsql.googleapis.com"])
  project  = var.project_id
  service  = each.key
  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "DATA_WRITE"
  }
  audit_log_config {
    log_type = "ADMIN_READ"
  }
}
resource "google_monitoring_notification_channel" "operator" {
  display_name = "SubKit Analytics operator"
  type         = "email"
  labels = {
    email_address = var.notification_email
  }
  depends_on = [google_project_service.enabled]
}
locals {
  expected_kms_principals = concat(var.enable_credential_encryption ? [google_service_account.runtime["api"].email, google_service_account.runtime["worker"].email] : [], var.additional_expected_kms_principals)
  kms_exclusions          = join("\n", [for principal in local.expected_kms_principals : "NOT protoPayload.authenticationInfo.principalEmail=${jsonencode(principal)}"])
}
resource "google_monitoring_alert_policy" "unexpected_kms_principal" {
  display_name          = "SubKit KEK used by unexpected principal"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.operator.name]
  conditions {
    display_name = "Unexpected encryption or decryption identity"
    condition_matched_log {
      filter = <<-FILTER
        protoPayload.serviceName="cloudkms.googleapis.com"
        protoPayload.resourceName:"${google_kms_crypto_key.credentials.id}"
        (protoPayload.methodName="Encrypt" OR protoPayload.methodName="Decrypt" OR protoPayload.methodName="google.cloud.kms.v1.KeyManagementService.Encrypt" OR protoPayload.methodName="google.cloud.kms.v1.KeyManagementService.Decrypt")
        ${local.kms_exclusions}
      FILTER
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Review Cloud KMS Data Access audit logs. Confirm the caller and workload revision; contain unexpected grants. Never put plaintext secrets into incident notes."
    mime_type = "text/markdown"
  }
}
resource "google_billing_budget" "project" {
  count           = var.billing_account_id != "" ? 1 : 0
  billing_account = var.billing_account_id
  display_name    = "${var.name} monthly budget"
  budget_filter {
    projects        = ["projects/${data.google_project.current.number}"]
    calendar_period = "MONTH"
  }
  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.monthly_budget_usd)
    }
  }
  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }
  all_updates_rule {
    monitoring_notification_channels = [google_monitoring_notification_channel.operator.name]
    disable_default_iam_recipients   = false
  }
}
