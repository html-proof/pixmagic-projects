# Production infrastructure on Google Cloud (Firebase projects are GCP projects).
#   Cloud Run: web, api, worker  |  Cloud SQL Postgres 17  |  Memorystore Redis
#   Secret Manager for every secret  |  Serverless VPC connector for private DB/Redis
# Usage: see docs/deployment.md

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  services = toset(["run.googleapis.com", "sqladmin.googleapis.com", "redis.googleapis.com", "secretmanager.googleapis.com", "vpcaccess.googleapis.com", "artifactregistry.googleapis.com", "cloudscheduler.googleapis.com"])
  secrets = toset([
    "DATABASE_URL", "APP_DATABASE_URL", "SESSION_SECRET", "TOKEN_ENCRYPTION_KEYS", "OTP_PEPPER",
    "SHOPIFY_API_SECRET", "FIREBASE_SERVICE_ACCOUNT_B64", "SMTP_URL", "ALERT_SLACK_WEBHOOK_URL",
  ])
  common_env = {
    NODE_ENV              = "production"
    APP_URL               = "https://${var.app_domain}"
    API_URL               = "https://${var.api_domain}"
    FIREBASE_PROJECT_ID   = var.project_id
    SHOPIFY_API_KEY       = var.shopify_api_key
    SHOPIFY_SCOPES        = "read_orders,read_products"
    SHOPIFY_OPTIONAL_SCOPES = "read_customers,write_pixels,read_customer_events"
    SHOPIFY_API_VERSION   = "2025-10"
    EMAIL_FROM            = var.email_from
  }
}

resource "google_project_service" "apis" {
  for_each           = local.services
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "images" {
  repository_id = "insights"
  format        = "DOCKER"
  location      = var.region
  depends_on    = [google_project_service.apis]
}

# ---------------- Network ----------------
resource "google_compute_network" "vpc" {
  name                    = "insights-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  name          = "insights-subnet"
  ip_cidr_range = "10.10.0.0/24"
  network       = google_compute_network.vpc.id
}

resource "google_compute_global_address" "private_ip" {
  name          = "insights-private-ip"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "private_vpc" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip.name]
}

resource "google_vpc_access_connector" "connector" {
  name          = "insights-conn"
  ip_cidr_range = "10.8.0.0/28"
  network       = google_compute_network.vpc.name
  depends_on    = [google_project_service.apis]
}

# ---------------- Data stores ----------------
resource "google_sql_database_instance" "pg" {
  name                = "insights-pg"
  database_version    = "POSTGRES_17"
  deletion_protection = true
  settings {
    tier              = var.db_tier
    availability_type = "REGIONAL"
    disk_autoresize   = true
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    insights_config { query_insights_enabled = true }
  }
  depends_on = [google_service_networking_connection.private_vpc]
}

resource "google_sql_database" "app" {
  name     = "app"
  instance = google_sql_database_instance.pg.name
}

resource "google_redis_instance" "redis" {
  name               = "insights-redis"
  tier               = "STANDARD_HA"
  memory_size_gb     = 1
  redis_version      = "REDIS_7_2"
  authorized_network = google_compute_network.vpc.id
  transit_encryption_mode = "DISABLED" # BullMQ over private VPC; enable + use rediss:// if policy requires
  depends_on         = [google_project_service.apis]
}

# ---------------- Secrets ----------------
resource "google_secret_manager_secret" "s" {
  for_each  = local.secrets
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_service_account" "runtime" {
  account_id   = "insights-runtime"
  display_name = "Insights Cloud Run runtime"
}

resource "google_secret_manager_secret_iam_member" "access" {
  for_each  = google_secret_manager_secret.s
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "firebase_auth_admin" {
  project = var.project_id
  role    = "roles/firebaseauth.admin"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# ---------------- Services ----------------
module "api" {
  source          = "./modules/run_service"
  name            = "insights-api"
  image           = "${var.region}-docker.pkg.dev/${var.project_id}/insights/api:${var.image_tag}"
  region          = var.region
  service_account = google_service_account.runtime.email
  connector       = google_vpc_access_connector.connector.id
  env             = merge(local.common_env, { REDIS_URL = "redis://${google_redis_instance.redis.host}:6379" })
  secrets         = ["DATABASE_URL", "APP_DATABASE_URL", "SESSION_SECRET", "TOKEN_ENCRYPTION_KEYS", "OTP_PEPPER", "SHOPIFY_API_SECRET", "FIREBASE_SERVICE_ACCOUNT_B64", "SMTP_URL"]
  min_instances   = 1
  public          = true
  health_path     = "/readyz"
  depends_on      = [google_secret_manager_secret_iam_member.access]
}

module "worker" {
  source          = "./modules/run_service"
  name            = "insights-worker"
  image           = "${var.region}-docker.pkg.dev/${var.project_id}/insights/worker:${var.image_tag}"
  region          = var.region
  service_account = google_service_account.runtime.email
  connector       = google_vpc_access_connector.connector.id
  env             = merge(local.common_env, { REDIS_URL = "redis://${google_redis_instance.redis.host}:6379", WORKER_HEALTH_PORT = "8080" })
  secrets         = ["DATABASE_URL", "TOKEN_ENCRYPTION_KEYS", "OTP_PEPPER", "SHOPIFY_API_SECRET", "SMTP_URL", "ALERT_SLACK_WEBHOOK_URL"]
  min_instances   = 1
  cpu_always_on   = true # background consumer, not request-driven
  public          = false
  health_path     = "/readyz"
  depends_on      = [google_secret_manager_secret_iam_member.access]
}

module "web" {
  source          = "./modules/run_service"
  name            = "insights-web"
  image           = "${var.region}-docker.pkg.dev/${var.project_id}/insights/web:${var.image_tag}"
  region          = var.region
  service_account = google_service_account.runtime.email
  connector       = google_vpc_access_connector.connector.id
  env             = { NODE_ENV = "production", API_INTERNAL_URL = module.api.url }
  secrets         = []
  min_instances   = 0
  public          = true
  health_path     = "/login"
}
