variable "project_id" {
  type        = string
  description = "GCP / Firebase project id"
}

variable "region" {
  type    = string
  default = "australia-southeast1"
}

variable "app_domain" {
  type        = string
  description = "Public web domain, e.g. app.example.com"
}

variable "api_domain" {
  type        = string
  description = "Public API domain (webhooks + pixel), e.g. api.example.com"
}

variable "shopify_api_key" {
  type        = string
  description = "Shopify app client id (public)"
}

variable "email_from" {
  type    = string
  default = "Insights <no-reply@example.com>"
}

variable "db_tier" {
  type    = string
  default = "db-custom-2-7680"
}

variable "image_tag" {
  type        = string
  description = "Container tag to deploy (git sha)"
}
