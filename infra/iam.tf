# The api, worker and migrate job run as this account: the PDFs bucket and the secrets, nothing else.
resource "google_service_account" "app" {
  account_id   = "${var.app}-app"
  display_name = "lomi api, worker and migrate job"
  depends_on   = [google_project_service.this]
}

# Cloud Build runs as this account: push images, write build logs, read the uploaded source.
resource "google_service_account" "build" {
  account_id   = "${var.app}-build"
  display_name = "lomi image builds"
  depends_on   = [google_project_service.this]
}

resource "google_artifact_registry_repository_iam_member" "build" {
  repository = google_artifact_registry_repository.images.name
  location   = var.region
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.build.member
}

resource "google_project_iam_member" "build" {
  for_each = toset(["roles/logging.logWriter", "roles/storage.objectViewer"])
  project  = var.project_id
  role     = each.key
  member   = google_service_account.build.member
}
