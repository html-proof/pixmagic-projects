#!/bin/bash
# render-monitoring.sh: on the server, before `docker compose -f docker-compose.monitoring.yml up -d`.
# Alertmanager can't read settings from the environment, so its file is written here from
# monitoring/alertmanager.yml.template and env/alerting.env, and Resend's SMTP password goes to its
# own file (monitoring/smtp_password), which only the alertmanager container mounts.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f env/alerting.env ] || { echo "missing env/alerting.env (env/alerting.env.example)" >&2; exit 1; }
# Grafana's admin password, the monitoring login: a placeholder from an env/*.example is public.
if placeholders="$(grep -l 'CHANGE_ME' env/*.env 2>/dev/null)"; then
  echo "placeholder values (CHANGE_ME) still in: $(echo $placeholders): give each its own value" >&2
  exit 1
fi
get() { sed -n "s/^$1=//p" env/alerting.env | tail -1; }
to="$(get ALERT_EMAIL_TO)"; from="$(get ALERT_EMAIL_FROM)"; pw="$(get RESEND_SMTP_PASSWORD)"
[ -n "$to" ] && [ -n "$from" ] && [ -n "$pw" ] || { echo "env/alerting.env needs ALERT_EMAIL_TO, ALERT_EMAIL_FROM and RESEND_SMTP_PASSWORD" >&2; exit 1; }
case "$to$from" in *[\|\&\]*) echo "an address has a character this script won't substitute" >&2; exit 1;; esac
# Other users on the host can't enter this folder; the containers' own users read the files.
chmod 750 .
sed -e "s|\${ALERT_EMAIL_TO}|$to|" -e "s|\${ALERT_EMAIL_FROM}|$from|" monitoring/alertmanager.yml.template > monitoring/alertmanager.yml
umask 022
printf '%s' "$pw" > monitoring/smtp_password
echo "rendered monitoring/alertmanager.yml and monitoring/smtp_password"
