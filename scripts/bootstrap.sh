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

# Reads .env the way Docker Compose does, rather than sourcing it as shell.
#
# Compose's .env is NOT a shell script: values may contain spaces unquoted and
# are never expanded. `. ./.env` therefore chokes on a perfectly valid line
# like `WEBAUTHN_RP_NAME=Cloud Platform`, treating "Platform" as a command.
# Parsing it here also means a stray line in .env cannot execute anything.
#
# This is for *this script's* own checks below. Compose reads .env itself, via
# the --env-file that scripts/compose.sh passes — do not rely on these exports
# reaching it, or a bare `docker compose -f stack/…` will look correct here and
# fail for anyone running it by hand.
load_env() {
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip blanks, comments and anything that is not KEY=VALUE.
    case "$line" in
      ''|'#'*) continue ;;
      *=*) ;;
      *) continue ;;
    esac

    key=${line%%=*}
    value=${line#*=}

    # `export FOO=bar` is valid in some .env dialects; tolerate the prefix.
    key=${key#export }
    # Trim surrounding whitespace from the key.
    key=$(printf '%s' "$key" | tr -d '[:space:]')

    # Reject anything that is not a valid shell identifier.
    case "$key" in
      ''|[0-9]*|*[!A-Za-z0-9_]*) continue ;;
    esac

    # Strip one layer of matching quotes, as Compose does.
    case "$value" in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
    esac

    export "$key=$value"
  done < .env
}

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

load_env

# The compose files refuse to start without these, so fail here where the
# message is friendlier rather than mid-`up`.
for required in DOMAIN ACME_EMAIL SESSION_SECRET HDD_PATH STORAGEBOX_PATH MINECRAFT_PATH; do
  [ -n "${!required:-}" ] || die "$required is not set in .env"
done
ok "required settings present"

if [ "${SESSION_SECRET}" = "change-me" ] || [ ${#SESSION_SECRET} -lt 32 ]; then
  die "SESSION_SECRET must be a long random value. Generate one with: openssl rand -base64 48"
fi

# ---------------------------------------------------------------- storage --

step "Storage tiers"

# No defaults for the three mount paths: the compose files have none either,
# and a default here would create a directory layout somewhere the containers
# will never look.
NVME_CACHE="${NVME_CACHE:-/var/cache/jellyfin}"

mkdir -p "$NVME_CACHE" "$MINECRAFT_PATH" "${IMMICH_DB_PATH:-/var/lib/immich/postgres}"

if mountpoint -q "$HDD_PATH"; then
  ok "local HDD mounted at $HDD_PATH"
  # The layout the dashboard and the compose files expect.
  mkdir -p "$HDD_PATH"/{Media/{Movies,TV,Music},Photos,Sync,Downloads,Projects,Snapshots}
  ok "created the HDD directory layout"
else
  warn "$HDD_PATH is not a mount point — is the 1 TB volume attached?"
fi

if mountpoint -q "$STORAGEBOX_PATH"; then
  ok "StorageBox mounted at $STORAGEBOX_PATH"
  mkdir -p "$STORAGEBOX_PATH"/{Cloud/{Documents,Photos,Videos,Shared},Media/{Movies,TV,Music},Archive,Vault,Backups/{VPS,Minecraft,Photos,Databases}}
  ok "created the StorageBox directory layout"
else
  warn "$STORAGEBOX_PATH is not mounted."
  warn "Run scripts/storagebox-mount.sh to set up the rclone mount first."
fi

# ------------------------------------------------------------------ build --

step "Building the dashboard image"
./scripts/compose.sh core build dashboard
ok "image built"

# ------------------------------------------------------------------- boot --

step "Starting the core stack"
./scripts/compose.sh core up -d
ok "proxy and dashboard running"

echo
echo "${BOLD}Next steps${RESET}"
echo "  1. Open ${BOLD}https://panel.${DOMAIN}${RESET} over your VPN and create the owner account."
echo "     ${DIM}You will be required to set up two-factor authentication immediately.${RESET}"
echo "  2. Bring up the services you want:"
echo "       ${DIM}sudo ./scripts/compose.sh media up -d${RESET}"
echo "       ${DIM}sudo ./scripts/compose.sh cloud up -d${RESET}   # photos + sync"
echo "  3. Leave Minecraft and the desktop stopped — the dashboard starts them on demand."
echo
echo "  ${DIM}The dashboard is bound to loopback and published only on the VPN.${RESET}"
echo "  ${DIM}If panel.${DOMAIN} does not resolve over the VPN, see docs/install.md.${RESET}"
