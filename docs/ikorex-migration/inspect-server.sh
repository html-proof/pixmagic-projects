#!/usr/bin/env bash
# Read-only inventory of the iKorex server, for SERVER_CAPACITY_REPORT.md.
#
#   ssh deployer@103.146.112.176 'bash -s' < docs/ikorex-migration/inspect-server.sh > ikorex-inventory.txt
#   (PowerShell 5.1: SERVER_CAPACITY_REPORT.md has the `cmd /c` form.)
#
# It changes nothing: no installs, no restarts, no files written, no containers touched.
# It prints no secrets: no environment variables, no file contents beyond nginx `listen` and
# `server_name` lines, no command lines from crontab (only their schedule and program name).
# sudo is only tried with -n (never prompts) and only for read-only status commands.
set -u
section() { printf '\n=== %s\n' "$1"; }

section "host"
hostnamectl 2>/dev/null | grep -vE "Machine ID|Boot ID"
grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release
uname -srm
echo "virtualisation: $(systemd-detect-virt 2>/dev/null || echo unknown)"
uptime
timedatectl 2>/dev/null | grep -E 'Time zone|synchronized'

section "cpu"
echo "cores: $(nproc)"
lscpu | grep -E '^(Model name|CPU\(s\)|Thread|Core|Socket|CPU max MHz)'

section "memory"
free -m
swapon --show 2>/dev/null

section "disk"
df -hT -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null
lsblk -o NAME,SIZE,TYPE,ROTA,MOUNTPOINT 2>/dev/null

section "load: vmstat, 1 s x 5"
vmstat 1 5

section "top 25 processes by memory"
ps -eo user,pid,%cpu,%mem,rss,etime,comm --sort=-rss | head -26

section "listening sockets (protocol, address:port)"
ss -tulnH 2>/dev/null | awk '{print $1, $5}' | sort -u

section "systemd services running"
systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null | awk '{print $1}'

section "systemd timers"
systemctl list-timers --all --no-legend --no-pager 2>/dev/null | awk '{print $(NF-1), $NF}' | head -40

section "docker"
docker version --format 'server {{.Server.Version}}' 2>&1 | head -1
docker compose version 2>&1 | head -1
echo "-- containers"
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>&1
echo "-- usage now"
docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' 2>&1
echo "-- restart policy and limits"
for c in $(docker ps -q 2>/dev/null); do
  docker inspect --format '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}} mem={{.HostConfig.Memory}} nanocpus={{.HostConfig.NanoCpus}}' "$c"
done
echo "-- compose projects"
docker compose ls 2>&1
echo "-- networks"
docker network ls --format '{{.Name}}\t{{.Driver}}' 2>&1
echo "-- volumes: $(docker volume ls -q 2>/dev/null | wc -l)"
docker system df 2>&1

section "web servers, proxies, tunnels"
for b in nginx caddy apache2 httpd traefik haproxy cloudflared tailscale wg frpc ngrok pm2 node n8n psql redis-server; do
  command -v "$b" >/dev/null 2>&1 && echo "$b: $(command -v "$b")"
done
nginx -v 2>&1 | head -1
ls /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null
grep -rhE '^\s*(server_name|listen)\b' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | sed 's/^\s*//' | sort | uniq -c
[ -f /etc/caddy/Caddyfile ] && grep -hE '^[^#[:space:]].*\{' /etc/caddy/Caddyfile

section "firewall and sudo (read-only)"
if sudo -n true 2>/dev/null; then
  echo "deployer has passwordless sudo"
  sudo -n ufw status verbose 2>&1 | head -40
  sudo -n fail2ban-client status 2>&1 | head -10
else
  echo "sudo needs a password: firewall not read"
fi
groups

# For SECURITY_AUDIT.md's open items: settings and names only, never a file's contents.
section "security settings (read-only)"
echo "-- sshd (password and root logins)"
grep -hiE '^\s*(PasswordAuthentication|PermitRootLogin|PubkeyAuthentication|KbdInteractiveAuthentication|AllowUsers|AllowGroups)\b' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | sed 's/^\s*//'
echo "-- docker group (root on this host for its members): $(getent group docker | cut -d: -f4)"
docker info --format 'rootless={{.Rootless}} security={{.SecurityOptions}} cgroup={{.CgroupVersion}} logging={{.LoggingDriver}}' 2>&1 | head -1
[ -r /etc/docker/daemon.json ] && echo "daemon.json keys: $(grep -oE '"[A-Za-z0-9_-]+"[[:space:]]*:' /etc/docker/daemon.json | tr -d '":' | tr -s ' \n' ' ')"
echo "-- disks (crypto_LUKS = encrypted at rest)"
lsblk -o NAME,TYPE,FSTYPE,SIZE,MOUNTPOINTS 2>/dev/null || lsblk -o NAME,TYPE,FSTYPE,SIZE,MOUNTPOINT
echo "-- automatic security updates"
systemctl is-active unattended-upgrades 2>/dev/null || echo "unattended-upgrades: not running"
grep -hE 'Unattended-Upgrade|Update-Package-Lists' /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null
echo "fail2ban: $(systemctl is-active fail2ban 2>/dev/null || echo unknown)"
echo "-- programs running as $(id -un) (names and counts)"
ps -u "$(id -u)" -o comm= 2>/dev/null | sort | uniq -c | sort -rn | head -25
echo "-- files under ~ that every user can read, by kind (counts only)"
echo ".env files: $(find ~ -maxdepth 4 -name '*.env' -perm -o=r 2>/dev/null | wc -l), key files: $(find ~ -maxdepth 4 \( -name 'id_*' ! -name '*.pub' -o -name '*.pem' -o -name '*.key' \) -perm -o=r 2>/dev/null | wc -l)"

section "deployer's home (names and sizes only)"
ls -la ~ 2>/dev/null
du -sh ~/* 2>/dev/null | sort -h | tail -20

section "crontab (schedule and program only)"
crontab -l 2>/dev/null | grep -vE '^\s*(#|$)' | awk '{ split($6, p, "/"); print $1, $2, $3, $4, $5, p[length(p)] }'

section "network"
ip -brief addr 2>/dev/null
ip route 2>/dev/null | head -5
ip -6 route 2>/dev/null | head -3
command -v vnstat >/dev/null 2>&1 && vnstat -m 2>/dev/null | tail -8

section "updates"
[ -f /var/run/reboot-required ] && echo "reboot required" || echo "no reboot pending"
echo "upgradable packages: $(apt list --upgradable 2>/dev/null | grep -c upgradable)"

section "limits"
echo "open files: $(ulimit -n)"
sysctl vm.swappiness vm.overcommit_memory 2>/dev/null
