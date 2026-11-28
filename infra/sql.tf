resource "random_password" "db" {
  length  = 32
  special = false # it goes into a URL unescaped
}

resource "google_sql_database_instance" "main" {
  name                = var.app
  database_version    = "POSTGRES_18"
  region              = var.region
  deletion_protection = false

  settings {
    edition = "ENTERPRISE" # shared-core tiers are Enterprise only
    tier    = "db-f1-micro"

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.main.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
  }

  depends_on = [google_service_networking_connection.services]
}

resource "google_sql_database" "main" {
  name     = var.app
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "main" {
  name            = var.app
  instance        = google_sql_database_instance.main.name
  password        = random_password.db.result
  deletion_policy = "ABANDON"
}
