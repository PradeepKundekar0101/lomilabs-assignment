resource "google_storage_bucket" "pdfs" {
  name                        = "${var.project_id}-pdfs"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
  depends_on                  = [google_project_service.this]
}

resource "google_storage_bucket_iam_member" "app" {
  bucket = google_storage_bucket.pdfs.name
  role   = "roles/storage.objectUser"
  member = google_service_account.app.member
}
