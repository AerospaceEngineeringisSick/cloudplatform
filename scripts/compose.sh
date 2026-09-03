#!/usr/bin/env bash
#
# Runs Docker Compose against one of the platform's stacks, with .env found.
#
#   sudo ./scripts/compose.sh core up -d
#   sudo ./scripts/compose.sh media logs -f jellyfin
#   sudo ./scripts/compose.sh cloud pull
#
# Why this exists rather than calling docker compose directly:
#
# Compose looks for .env in the *project directory*, which defaults to the
# directory holding the first -f file. `docker compose -f stack/foo.yml` run
# from the repository root therefore looks for stack/.env and never reads the
# .env you actually edited. Required variables then fail loudly, but defaulted
# ones fail silently — HDD_PATH quietly reverts to /mnt/hdd and Jellyfin mounts
# an empty directory instead of your disk.
#
# `--project-directory .` is not the fix: it also re-roots every build context,
# so the dashboard image would be built from the parent of the repository.
# Pointing --env-file at the real file is, and that is all this does.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

STACKS="core media cloud games desktop"

usage() {
  cat >&2 <<USAGE
usage: scripts/compose.sh <stack> <docker-compose args…>

  stacks:  ${STACKS}

  core     the reverse proxy and the dashboard
  media    Jellyfin
  cloud    Immich and Syncthing
  games    Minecraft
  desktop  the browser desktop

examples:
  scripts/compose.sh core up -d
  scripts/compose.sh core up -d --force-recreate dashboard
  scripts/compose.sh media ps
  scripts/compose.sh games logs -f
USAGE
  exit 2
}

[ $# -ge 1 ] || usage

STACK="$1"; shift
case " ${STACKS} " in
  *" ${STACK} "*) ;;
  *) echo "unknown stack: ${STACK}" >&2; usage ;;
esac

FILE="${ROOT}/stack/docker-compose.${STACK}.yml"
[ -f "$FILE" ] || { echo "missing compose file: ${FILE}" >&2; exit 1; }

if [ ! -f "${ROOT}/.env" ]; then
  echo "no ${ROOT}/.env — run scripts/bootstrap.sh first." >&2
  exit 1
fi

# Each stack is its own Compose project, so exactly one -f is correct here.
# Merging them would put every container under a single project name and the
# next `down` would take out more than you meant.
exec docker compose --env-file "${ROOT}/.env" -f "$FILE" "$@"
