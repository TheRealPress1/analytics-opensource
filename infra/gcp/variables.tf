variable "project_id" {
  type = string
}
variable "region" {
  type    = string
  default = "us-east4"
}
variable "name" {
  type    = string
  default = "subkit-analytics"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,19}$", var.name))
    error_message = "Use 3-20 lowercase letters, digits or hyphens, starting with a letter."
  }
}
variable "github_repository" {
  type        = string
  description = "OWNER/REPOSITORY, used to pin the allowed workflow."
}
variable "github_repository_id" {
  type        = string
  description = "Immutable numeric GitHub repository ID."
}
variable "github_owner_id" {
  type        = string
  description = "Immutable numeric GitHub owner/organization ID."
}
variable "github_branch" {
  type    = string
  default = "main"
}
variable "github_environment" {
  type    = string
  default = "staging"
}
variable "deploy_services" {
  type        = bool
  default     = false
  description = "Enable only after images, secret versions and SQL grants exist."
}
variable "api_image" {
  type        = string
  default     = ""
  description = "Artifact Registry image pinned by sha256 digest."
}
variable "worker_image" {
  type        = string
  default     = ""
  description = "Artifact Registry image pinned by sha256 digest."
}
variable "token_secret_version" {
  type        = string
  default     = "1"
  description = "Explicit Secret Manager version; secret payload is provisioned outside Terraform."
}
variable "db_tier" {
  type    = string
  default = "db-custom-1-3840"
}
variable "db_availability_type" {
  type    = string
  default = "ZONAL"
  validation {
    condition     = contains(["ZONAL", "REGIONAL"], var.db_availability_type)
    error_message = "Choose ZONAL or REGIONAL."
  }
}
variable "db_name" {
  type    = string
  default = "analytics"
}
variable "enable_credential_encryption" {
  type        = bool
  default     = true
  description = "Grant API and worker access to the KEK only if an encryption consumer is enabled."
}
variable "notification_email" {
  type        = string
  description = "Email receiving security and budget alerts; must be verified in Cloud Monitoring."
}
variable "billing_account_id" {
  type        = string
  default     = ""
  description = "Optional billing account for a project-scoped budget. Required before live pilot."
}
variable "monthly_budget_usd" {
  type    = number
  default = 50
  validation {
    condition     = var.monthly_budget_usd > 0 && floor(var.monthly_budget_usd) == var.monthly_budget_usd
    error_message = "Budget must be a positive whole USD amount."
  }
}
variable "additional_expected_kms_principals" {
  type        = list(string)
  default     = []
  description = "Explicit operator/service-account email exceptions for the KEK usage alert."
}
variable "enable_pubsub_foundation" {
  type        = bool
  default     = false
  description = "Create an unused generic topic and dead-letter topic; no store integrations, subscriptions or publishers."
}
variable "deploy_jobs" {
  type        = bool
  default     = false
  description = "Create migration and KMS acceptance jobs before services, so a fresh database can be initialized."
}
