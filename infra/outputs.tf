output "api_url" {
  value = local.services ? google_cloud_run_v2_service.api[0].uri : null
}

output "project_id" {
  value = var.project_id
}

output "region" {
  value = var.region
}

output "registry" {
  value = local.registry
}

output "build_service_account" {
  value = google_service_account.build.id
}
