locals {
  deploy   = var.image_tag != ""
  services = local.deploy && var.start_services
  images   = { api = "${local.registry}/api:${var.image_tag}", worker = "${local.registry}/worker:${var.image_tag}" }

  # Plain configuration. Secrets come from Secret Manager below, so they never show in a revision's plain environment.
  env = {
    REDIS_URL  = "redis://${google_redis_instance.main.host}:${google_redis_instance.main.port}"
    GCS_BUCKET = google_storage_bucket.pdfs.name # read and written as the service account, through the JSON API
  }
  secret_env = { DATABASE_URL = "database-url" }
  api_env    = merge(local.env, var.web_origin == "" ? {} : { WEB_ORIGIN = var.web_origin })
  worker_env = merge(local.env, { LLM_MODEL = var.llm_model, WORKER_CONCURRENCY = "2", LEASE_SECONDS = "60", RECONCILE_SECONDS = "15" })

  # Secrets must exist and be readable before a revision starts.
  run_deps = [google_secret_manager_secret_version.this, google_secret_manager_secret_iam_member.app, google_storage_bucket_iam_member.app]
}

# One-off: migrations, then the fixture seed, from the api image (as compose's migrate-seed). scripts/run-migrate.sh runs it.
resource "google_cloud_run_v2_job" "migrate" {
  count               = local.deploy ? 1 : 0
  name                = "migrate"
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.app.email
      max_retries     = 0
      timeout         = "600s"

      containers {
        image   = local.images.api
        command = ["sh", "-c"]
        args    = ["cd node_modules/@lomi/db && node_modules/.bin/prisma migrate deploy && cd /app && exec node dist/seed.js"]

        dynamic "env" {
          for_each = local.env
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = local.secret_env
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.this[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
      }

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.main.id
          subnetwork = google_compute_subnetwork.run.id
        }
      }
    }
  }

  depends_on = [local.run_deps]
}

resource "google_cloud_run_v2_service" "api" {
  count               = local.services ? 1 : 0
  name                = "api"
  location            = var.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL"
  # A public API. This skips the run.invoker check instead of granting allUsers, which org policies often forbid.
  invoker_iam_disabled = true

  template {
    service_account = google_service_account.app.email

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      image = local.images.api
      ports {
        container_port = 3000 # Cloud Run sets PORT to this
      }

      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }

      # Liveness only: /health answers 503 while Postgres or Redis is down, and replacing the api would not fix that.
      startup_probe {
        http_get {
          path = "/health/live"
        }
      }

      dynamic "env" {
        for_each = local.api_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.this[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.run.id
      }
    }
  }

  depends_on = [local.run_deps]
}

# A worker pool runs a container with no HTTP endpoint and no request-driven scaling: exactly the BullMQ worker.
resource "google_cloud_run_v2_worker_pool" "worker" {
  count               = local.services ? 1 : 0
  name                = "worker"
  location            = var.region
  deletion_protection = false

  scaling {
    manual_instance_count = 1
  }

  template {
    service_account = google_service_account.app.email

    containers {
      image = local.images.worker

      resources {
        limits = { cpu = "1", memory = "1Gi" }
      }

      dynamic "env" {
        for_each = local.worker_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = merge(local.secret_env, { ANTHROPIC_API_KEY = "anthropic-api-key" })
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.this[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.run.id
      }
    }
  }

  depends_on = [local.run_deps]
}
