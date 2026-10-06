output "api_url" {
  value = module.api.url
}

output "web_url" {
  value = module.web.url
}

output "db_connection_name" {
  value = google_sql_database_instance.pg.connection_name
}

output "redis_host" {
  value = google_redis_instance.redis.host
}
