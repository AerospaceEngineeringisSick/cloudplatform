# Installation

From a bare Debian or Ubuntu VPS to a working platform. Budget about an hour,
most of which is waiting for Nextcloud to initialise.

## Before you start

You need:

- A VPS with root, Debian 12 or Ubuntu 22.04+, and FUSE available.
- A domain you control, with DNS you can edit.
- The StorageBox hostname, username, and either a password or an SSH key.
- A VPN. Tailscale is assumed below because it is the least work; WireGuard is
  fine if you already run it.

## 1. DNS

Point four names at the VPS's public IP:

```
media.example.com    A    203.0.113.10
cloud.example.com    A    203.0.113.10
panel.example.com    A    203.0.113.10
host.example.com     A    203.0.113.10
```

All four resolve publicly, which is fine: `panel` and `host` answer only to
requests arriving from inside the VPN, and refuse everything else with a 403.
Caddy still needs them public so it can complete the ACME HTTP challenge and
issue certificates.

> If you would rather `panel` not appear in public DNS at all, use a DNS-01
> ACME challenge and a split-horizon record. It is more setup for a modest gain
> — the 403 already prevents access.

## 2. The VPN

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Note the machine's Tailscale address (`tailscale ip -4`). Install Tailscale on
your laptop and phone too, and on Ralph's.

The default `TAILSCALE_CIDR` in `.env` is `100.64.0.0/10`, which covers every
Tailscale address. For WireGuard, set it to your tunnel subnet instead, e.g.
`10.8.0.0/24`.

## 3. Storage

**The 1 TB volume.** Attach and mount it at `/mnt/hdd`, with an `fstab` entry so
it survives a reboot:

```bash
sudo mkfs.ext4 /dev/sdb          # ONLY if it is empty — this destroys data
sudo mkdir -p /mnt/hdd
echo "/dev/sdb /mnt/hdd ext4 defaults,noatime 0 2" | sudo tee -a /etc/fstab
sudo mount -a
```

`noatime` is deliberate: it avoids a metadata write on every read. The tiering
engine falls back to modification time, so nothing is lost.

**The StorageBox.** Configure the rclone remote first:

```bash
sudo apt-get install -y rclone fuse3
sudo rclone config
```

Choose `n` for a new remote, name it `storagebox`, type `sftp`, then give it the
host, user and key. `stack/rclone.conf.example` shows a finished file. A key is
better than a password:

```bash
sudo ssh-keygen -t ed25519 -f /root/.ssh/storagebox -N ""
ssh-copy-id -i /root/.ssh/storagebox.pub -p 22 USER@STORAGEBOX_HOST
```

Test it before going further:

```bash
sudo rclone lsd storagebox:
```

## 4. The platform

```bash
sudo git clone <this-repo> /opt/cloudplatform
cd /opt/cloudplatform
sudo ./scripts/bootstrap.sh
```

The first run creates `.env` with a freshly generated `SESSION_SECRET` and
stops. Fill in the rest:

```bash
sudo nano .env
```

The ones that matter:

| Setting | Notes |
|---|---|
| `DOMAIN` | `example.com` — the subdomains are derived from it |
| `ACME_EMAIL` | where Let's Encrypt sends expiry warnings |
| `DASHBOARD_ORIGIN` | `https://panel.example.com`, exactly as the browser shows it |
| `WEBAUTHN_RP_ID` | `panel.example.com` — passkeys are bound to this |
| `TAILSCALE_CIDR` | your VPN's range |
| `NET_IFACE` | check with `ip -br link` |
| `MC_RCON_PASSWORD` | `openssl rand -hex 24` |
| `NEXTCLOUD_DB_PASSWORD` | `openssl rand -hex 24` |
| `NEXTCLOUD_ADMIN_PASSWORD` | your own, and make it long |
| `DESKTOP_PASSWORD` | your own — this desktop is root-capable |

> `SESSION_SECRET` must stay stable. Changing it signs everyone out.
> `WEBAUTHN_RP_ID` must match the hostname exactly, or passkeys will not
> register.

Mount the StorageBox, then run bootstrap again:

```bash
sudo ./scripts/storagebox-mount.sh
sudo ./scripts/bootstrap.sh
```

The mount script installs a systemd unit, so it reconnects on boot and after a
dropped connection.

## 5. First sign-in

Open `https://panel.example.com` **with the VPN connected**.

1. Create the owner account. Twelve characters minimum; a memorable passphrase
   beats a short scramble.
2. Set up two-factor authentication. This is not optional — nothing else
   unlocks until it is done. Scan the QR with Aegis, 1Password, Bitwarden or
   Google Authenticator.
3. **Save the ten recovery codes.** They are shown exactly once, because the
   server keeps only hashes. Put them in a password manager, or print them.

Add a passkey afterwards under Security, so day-to-day sign-in is a fingerprint
rather than a typed code.

## 6. The services

```bash
cd /opt/cloudplatform
docker compose -f stack/docker-compose.media.yml up -d
docker compose -f stack/docker-compose.cloud.yml up -d
```

**Jellyfin** — finish setup at `https://media.example.com`. Add two libraries:
`/media/local` (the HDD) and `/media/remote` (the StorageBox). Then create an
API key under Dashboard → API Keys, put it in `.env` as `JELLYFIN_API_KEY`, and
restart the dashboard so it can show streams and transcodes:

```bash
docker compose -f stack/docker-compose.core.yml up -d --force-recreate dashboard
```

**Nextcloud** — finish setup at `https://cloud.example.com`. To attach the
StorageBox as external storage:

1. Enable the *External storage support* app.
2. Settings → Administration → External storage.
3. Add storage: *Local*, pointing at `/mnt/storagebox/Cloud`.

Using the already-mounted path is faster and simpler than making Nextcloud open
its own SFTP session.

**Minecraft and the desktop** — build the images but leave them stopped:

```bash
docker compose -f stack/docker-compose.games.yml create
docker compose -f stack/docker-compose.desktop.yml create
```

The dashboard starts them on demand and switches profiles around them.

## 7. Check it

On the Overview page you should see live gauges, all three storage tiers
online, and green availability bars. On Settings, every integration should read
*Connected*.

If Jellyfin says *Not configured*, the API key is missing or wrong. If the
StorageBox reads *offline*, see [runbook.md](runbook.md).

## Updating

```bash
cd /opt/cloudplatform
git pull
docker compose -f stack/docker-compose.core.yml up -d --build
```

The database migrates itself on start. Migrations are append-only, so a
downgrade needs a restore from backup — the nightly job puts one on the
StorageBox.
