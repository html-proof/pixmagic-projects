variable "name" { type = string }
variable "image" { type = string }
variable "region" { type = string }
variable "service_account" { type = string }
variable "connector" { type = string }
variable "env" { type = map(string) }
variable "secrets" { type = list(string) }
variable "min_instances" { type = number }
variable "public" { type = bool }
variable "health_path" { type = string }
variable "cpu_always_on" {
  type    = bool
  default = false
}

resource "google_cloud_run_v2_service" "svc" {
  name     = var.name
  location = var.region
  ingress  = var.public ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = var.service_account
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = 20
    }
    vpc_access {
      connector = var.connector
      egress    = "PRIVATE_RANGES_ONLY"
    }
    containers {
      image = var.image
      resources {
        cpu_idle = !var.cpu_always_on
        limits   = { cpu = "1", memory = "1Gi" }
      }
      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = toset(var.secrets)
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get { path = var.health_path }
        failure_threshold = 10
        period_seconds    = 3
      }
      liveness_probe {
        http_get { path = var.health_path == "/login" ? "/login" : "/healthz" }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.public ? 1 : 0
  name     = google_cloud_run_v2_service.svc.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "url" {
  value = google_cloud_run_v2_service.svc.uri
}
