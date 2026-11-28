resource "google_artifact_registry_repository" "images" {
  repository_id = var.app
  location      = var.region
  format        = "DOCKER"
  depends_on    = [google_project_service.this]
}

locals {
  registry = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}
