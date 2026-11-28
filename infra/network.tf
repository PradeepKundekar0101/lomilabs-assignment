# Cloud Run reaches Cloud SQL and Memorystore through Direct VPC egress into this subnet; everything else
# (Cloud Storage, the Anthropic API) goes straight out, so there is no NAT. Nothing listens inside the VPC.
resource "google_compute_network" "main" {
  name                    = var.app
  auto_create_subnetworks = false
  depends_on              = [google_project_service.this]
}

resource "google_compute_subnetwork" "run" {
  name          = "${var.app}-run"
  network       = google_compute_network.main.id
  region        = var.region
  ip_cidr_range = "10.10.0.0/24"
}

# Private services access: Cloud SQL and Memorystore get private IPs from this range, and no public ones.
resource "google_compute_global_address" "services" {
  name          = "${var.app}-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "services" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.services.name]
  deletion_policy         = "ABANDON" # the peering cannot be removed until Cloud SQL is fully gone; destroy would fail
}
