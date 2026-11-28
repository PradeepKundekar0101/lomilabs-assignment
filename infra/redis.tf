# BullMQ requires noeviction: an evicted job key would silently drop a job.
resource "google_redis_instance" "main" {
  name               = var.app
  tier               = "BASIC"
  memory_size_gb     = 1
  region             = var.region
  redis_version      = "REDIS_7_2"
  authorized_network = google_compute_network.main.id
  connect_mode       = "PRIVATE_SERVICE_ACCESS"
  redis_configs      = { "maxmemory-policy" = "noeviction" }

  depends_on = [google_service_networking_connection.services]
}
