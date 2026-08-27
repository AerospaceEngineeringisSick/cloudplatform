#!/usr/bin/env bash
#
# Prepares a fresh Debian/Ubuntu VPS to run the platform.
#
#   sudo ./scripts/bootstrap.sh
#
# Idempotent: safe to re-run after changing .env or upgrading.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
RED=$'\033[31m'; RESET=$'\033[0m'

step()  { echo -e "\n${BOLD}==> $*${RESET}"; }
ok()    { echo -e "  ${GREEN}ok${RESET}  $*"; }
warn()  { echo -e "  ${YELLOW}!${RESET}   $*"; }
die()   { echo -e "  ${RED}✗${RESET}   $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo."

# --------------------------------------------------------------- packages --

step "Checking prerequisites"

if ! command -v docker > /dev/null; then
  warn "Docker is not installed. Installing from get.docker.com…"
  curl -fsSL https://get.docker.com | sh
fi
ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"

docker compose version > /dev/null 2>&1 || die "The Docker Compose plugin is missing."
ok "compose $(docker compose version --short)"

MISSING=()
for tool in rclone curl openssl; do
  command -v "$tool" > /dev/null || MISSING+=("$tool")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  warn "Installing: ${MISSING[*]}"
  apt-get update -qq
  apt-get install -y -qq "${MISSING[@]}"
fi
ok "rclone $(rclone version | head -1 | awk '{print $2}')"

# -------------------------------------------------------------------- env --

step "Configuration"

if [ ! -f .env ]; then
  cp .env.example .env
  # A stable session secret, generated once. Regenerating it logs everyone out.
  SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" .env
  ok "created .env with a fresh SESSION_SECRET"
  warn "Edit .env now — DOMAIN, ACME_EMAIL and the passwords must be set."
  warn "Then run this script again."
  exit 0
fi
ok ".env exists"

# shellcheck disable=SC1091
set -a; . ./.env; set +a

for required in DOMAIN ACME_EMAIL SESSION_SECRET; do
  [ -n "${!required:-}" ] || die "$required is not set in .env"
done
ok "required settings present"

if [ "${SESSION_SECRET}" = "change-me" ] || [ ${#SESSION_SECRET} -lt 32 ]; then
  die "SESSION_SECRET must be a long random value. Generate one with: openssl rand -base64 48"
fi

# ---------------------------------------------------------------- storage --

step "Storage tiers"

HDD_PATH="${HDD_PATH:-/mnt/hdd}"
STORAGEBOX_PATH="${STORAGEBOX_PATH:-/mnt/storagebox}"
NVME_CACHE="${NVME_CACHE:-/var/cache/jellyfin}"
MINECRAFT_PATH="${MINECRAFT_PATH:-/srv/minecraft}"

mkdir -p "$NVME_CACHE" "$MINECRAFT_PATH"

if mountpoint -q "$HDD_PATH"; then
  ok "local HDD mounted at $HDD_PATH"
  # The layout the dashboard and the compose files expect.
  mkdir -p "$HDD_PATH"/{Media/{Movies,TV,Music},Cloud,Downloads,Projects,Snapshots}
  ok "created the HDD directory layout"
else
  warn "$HDD_PATH is not a mount point — is the 1 TB volume attached?"
fi

if mountpoint -q "$STORAGEBOX_PATH"; then
  ok "StorageBox mounted at $STORAGEBOX_PATH"
  mkdir -p "$STORAGEBOX_PATH"/{Cloud/{Documents,Photos,Videos,Shared},Media/{Movies,TV,Music},Archive,Vault,Backups/{VPS,Minecraft,Websites,Databases}}
  ok "created the StorageBox directory layout"
else
  warn "$STORAGEBOX_PATH is not mounted."
  warn "Run scripts/storagebox-mount.sh to set up the rclone mount first."
fi

# ------------------------------------------------------------------ build --

step "Building the dashboard image"
docker compose -f stack/docker-compose.core.yml build dashboard
ok "image built"

# ------------------------------------------------------------------- boot --

step "Starting the core stack"
docker compose -f stack/docker-compose.core.yml up -d
ok "proxy and dashboard running"

echo
echo "${BOLD}Next steps${RESET}"
echo "  1. Open ${BOLD}https://panel.${DOMAIN}${RESET} over your VPN and create the owner account."
echo "     ${DIM}You will be required to set up two-factor authentication immediately.${RESET}"
echo "  2. Bring up the services you want:"
echo "       ${DIM}docker compose -f stack/docker-compose.media.yml up -d${RESET}"
echo "       ${DIM}docker compose -f stack/docker-compose.cloud.yml up -d${RESET}"
echo "  3. Leave Minecraft and the desktop stopped — the dashboard starts them on demand."
echo
echo "  ${DIM}The dashboard is bound to loopback and published only on the VPN.${RESET}"
echo "  ${DIM}If panel.${DOMAIN} does not resolve over the VPN, see docs/install.md.${RESET}"
