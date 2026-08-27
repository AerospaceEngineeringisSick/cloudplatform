#!/usr/bin/env bash
#
# Mounts the HostBrr StorageBox over SFTP with rclone, so 2 TB of remote bulk
# storage appears as an ordinary directory.
#
#   sudo ./scripts/storagebox-mount.sh
#
# Installs a systemd unit so the mount survives reboots and reconnects itself.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
ok()   { echo -e "  ${GREEN}ok${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}!${RESET}   $*"; }
die()  { echo -e "  ${RED}✗${RESET}   $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo."
[ -f "$ROOT/.env" ] || die "No .env found. Run scripts/bootstrap.sh first."
# shellcheck disable=SC1091
set -a; . "$ROOT/.env"; set +a

REMOTE="${RCLONE_REMOTE:-storagebox}"
MOUNT="${STORAGEBOX_PATH:-/mnt/storagebox}"
CACHE="${RCLONE_CACHE_DIR:-/var/cache/rclone}"
CONFIG="${RCLONE_CONFIG_PATH:-/root/.config/rclone/rclone.conf}"

command -v rclone > /dev/null || die "rclone is not installed."
command -v fusermount3 > /dev/null || command -v fusermount > /dev/null \
  || die "FUSE is missing. Install it with: apt-get install -y fuse3"

echo -e "\n${BOLD}==> Checking the rclone remote${RESET}"
if ! rclone --config "$CONFIG" listremotes 2>/dev/null | grep -q "^${REMOTE}:$"; then
  warn "No rclone remote named '${REMOTE}'."
  echo
  echo "  Create one with:"
  echo "      rclone config"
  echo
  echo "  Choose: n) New remote  →  name: ${REMOTE}  →  type: sftp"
  echo "  Then set host, user and either a password or a key file."
  echo "  A key is better: ssh-keygen -t ed25519, then upload the public key"
  echo "  to the StorageBox with ssh-copy-id."
  echo
  echo "  A worked example lives in stack/rclone.conf.example."
  exit 1
fi
ok "remote '${REMOTE}' is configured"

echo -e "\n${BOLD}==> Testing the connection${RESET}"
if ! timeout 30 rclone --config "$CONFIG" lsd "${REMOTE}:" > /dev/null 2>&1; then
  die "Could not list '${REMOTE}:'. Check the host, credentials and firewall."
fi
ok "connected"

mkdir -p "$MOUNT" "$CACHE"

echo -e "\n${BOLD}==> Installing the systemd unit${RESET}"
UNIT=/etc/systemd/system/storagebox.service
cat > "$UNIT" <<UNITEOF
[Unit]
Description=StorageBox (rclone SFTP mount)
Documentation=https://rclone.org/commands/rclone_mount/
After=network-online.target
Wants=network-online.target
AssertPathIsDirectory=${MOUNT}

[Service]
Type=notify
ExecStart=/usr/bin/rclone mount ${REMOTE}: ${MOUNT} \\
  --config ${CONFIG} \\
  --allow-other \\
  --dir-cache-time 72h \\
  --poll-interval 15s \\
  --vfs-cache-mode full \\
  --vfs-cache-max-age 24h \\
  --vfs-cache-max-size ${RCLONE_CACHE_SIZE:-20G} \\
  --vfs-read-chunk-size 32M \\
  --vfs-read-chunk-size-limit 512M \\
  --cache-dir ${CACHE} \\
  --buffer-size 32M \\
  --transfers ${RCLONE_TRANSFERS:-4} \\
  --umask 002 \\
  --log-level INFO
ExecStop=/bin/fusermount3 -uz ${MOUNT}
Restart=on-failure
RestartSec=10
# A dropped SFTP session should reconnect, not take the machine down.
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNITEOF
ok "wrote ${UNIT}"

# rclone needs user_allow_other so containers can read the mount.
if ! grep -q '^user_allow_other' /etc/fuse.conf 2>/dev/null; then
  echo 'user_allow_other' >> /etc/fuse.conf
  ok "enabled user_allow_other in /etc/fuse.conf"
fi

systemctl daemon-reload
systemctl enable --now storagebox.service
ok "service started"

echo -e "\n${BOLD}==> Verifying${RESET}"
for _ in $(seq 1 20); do
  if mountpoint -q "$MOUNT"; then break; fi
  sleep 1
done

if mountpoint -q "$MOUNT"; then
  ok "mounted at ${MOUNT}"
  mkdir -p "$MOUNT"/{Cloud/{Documents,Photos,Videos,Shared},Media/{Movies,TV,Music},Archive,Vault,Backups/{VPS,Minecraft,Websites,Databases}}
  ok "directory layout ready"
  echo
  df -h "$MOUNT" | tail -1
else
  die "The mount did not come up. Check: journalctl -u storagebox -n 50"
fi
