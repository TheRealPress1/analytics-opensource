terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    google = {
      source  = "hashicorp/google",
      version = "~> 7.0"
    }
  }
  # Use a separately bootstrapped, versioned, access-restricted GCS state bucket.
  # Supply its name with terraform init -backend-config=bucket=YOUR_STATE_BUCKET.
  backend "gcs" {
    prefix = "subkit-analytics"
  }
}
provider "google" {
  project               = var.project_id
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
}
