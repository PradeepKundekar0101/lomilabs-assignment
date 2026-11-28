terraform {
  required_version = ">= 1.10"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 8.12" }
    random = { source = "hashicorp/random", version = "~> 3.9" }
  }
  # shortcut: local state (gitignored, holds secrets); move to a GCS backend before more than one person deploys.
}

provider "google" {
  project        = var.project_id
  region         = var.region
  default_labels = { app = var.app, managed-by = "terraform" }
}

resource "google_project_service" "this" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "redis.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}
