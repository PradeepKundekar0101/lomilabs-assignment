# The containers get these as secret environment variables, never as plain ones.
locals {
  secret_values = {
    # Cloud SQL forces TLS. uselibpqcompat makes node-postgres read sslmode=require as libpq does: encrypt, don't verify the CA.
    # shortcut: the server certificate is not verified; bake in the instance's server CA and use sslmode=verify-ca to upgrade.
    database-url      = "postgres://${google_sql_user.main.name}:${random_password.db.result}@${google_sql_database_instance.main.private_ip_address}:5432/${google_sql_database.main.name}?sslmode=require&uselibpqcompat=true"
    anthropic-api-key = var.anthropic_api_key
  }
}

resource "google_secret_manager_secret" "this" {
  for_each  = toset(keys(local.secret_values))
  secret_id = "${var.app}-${each.key}"

  replication {
    auto {}
  }

  depends_on = [google_project_service.this]
}

resource "google_secret_manager_secret_version" "this" {
  for_each    = google_secret_manager_secret.this
  secret      = each.value.id
  secret_data = local.secret_values[each.key]
}

resource "google_secret_manager_secret_iam_member" "app" {
  for_each  = google_secret_manager_secret.this
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.app.member
}
