# Installation

From a bare Debian or Ubuntu VPS to a working platform. Budget about an hour,
most of which is waiting for images to pull and Immich to initialise.

## Before you start

You need:

- A VPS with root, Debian 12 or Ubuntu 22.04+, and FUSE available.
- A domain you control, with DNS you can edit.
- The StorageBox hostname, username, and either a password or an SSH key.
- A VPN. Tailscale is assumed below because it is the least work; WireGuard is
  fine if you already run it.

## 1. DNS

Point five names at the VPS's public IP:

```
media.example.com     A    203.0.113.10     public — Jellyfin
photos.example.com    A    203.0.113.10     public — Immich
panel.example.com     A    203.0.113.10     VPN only
sync.example.com      A    203.0.113.10     VPN only
host.example.com      A    203.0.113.10     VPN only
```

All five resolve publicly, which is fine by default: the last three answer only
to requests from inside the VPN and refuse everything else with a 403. Caddy
still needs them reachable so it can complete the ACME HTTP challenge.

**If you use Cloudflare for DNS, leave every record grey-clouded (DNS-only).**
The orange cloud replaces the client address that the VPN check depends on, and
would lock you out of your own control plane. With a Cloudflare API token you
can switch to DNS-01 certificates and drop the three private records from public
DNS entirely — see [edge.md](edge.md).

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

### The 1 TB volume — look before you touch it

**Most providers ship this disk already formatted and mounted.** Check before
doing anything else:

```bash
lsblk -f
df -h
```

If you see the disk with a filesystem and a mountpoint — commonly `/mnt/data` —
**it is done. Do not format it.** Skip to *Point the platform at it* below.

> `mkfs` destroys everything on the target in seconds and asks no questions.
> Run it only against a device that `lsblk -f` shows with an empty FSTYPE
> column. If you are unsure, you do not need to run it.

**Only if the disk is genuinely raw** (no FSTYPE, no mountpoint):

```bash
lsblk -f                              # confirm the target is empty FIRST
sudo mkfs.ext4 /dev/sdb1              # the PARTITION, not /dev/sdb
sudo mkdir -p /mnt/data
```

### Point the platform at it

There is nothing special about `/mnt/hdd`; the platform reads one variable.
Set it in `.env` to wherever the disk actually is:

```bash
HDD_PATH=/mnt/data
```

That single setting feeds Immich's library, Jellyfin's local media, Syncthing's
folders and the tiering engine. Moving the mount to match the docs is wasted
work — change the variable instead.

### Make sure it survives a reboot

```bash
findmnt /mnt/data                     # already mounted?
grep -i sdb /etc/fstab                # already persistent?
```

If there is no `fstab` entry, add one **by UUID** — device names can reorder
between boots, and an `fstab` line naming `/dev/sdb` can then mount the wrong
disk:

```bash
sudo blkid /dev/sdb1
echo "UUID=<uuid-from-above>  /mnt/data  ext4  defaults,noatime  0  2" | sudo tee -a /etc/fstab
sudo mount -a                         # silence means success
```

`noatime` is deliberate: it avoids a metadata write on every read. The tiering
engine falls back to modification time, so nothing is lost.

Finally, create the layout and take ownership, so containers running as your
UID can write to it:

```bash
sudo mkdir -p "$HDD_PATH"/{Media/{Movies,TV,Music},Photos,Sync,Downloads,Projects,Snapshots}
sudo chown -R "$USER:$USER" "$HDD_PATH"
```

> Every command from here on needs root. Either prefix each with `sudo`, or
> take a root shell once with `sudo -i`. Note that `sudo echo ... >> /etc/fstab`
> does **not** work — the redirect runs as your own user, so the write is
> refused. Use `| sudo tee -a` as above.

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
| `IMMICH_DB_PASSWORD` | `openssl rand -hex 24` — letters and digits only |
| `DESKTOP_PASSWORD` | your own — this desktop is root-capable |
| `CADDYFILE` | `Caddyfile` (default) or `Caddyfile.dns` for DNS-01 certificates |

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

Everything from here on goes through `scripts/compose.sh`, which is a one-line
wrapper around `docker compose`. It takes a stack name and passes the rest
straight through:

```bash
cd /opt/cloudplatform
sudo ./scripts/compose.sh media up -d
sudo ./scripts/compose.sh cloud up -d
```

> **Do not call `docker compose -f stack/…` directly.** Compose looks for
> `.env` in the *project directory*, which is the directory holding the `-f`
> file — so it reads `stack/.env`, which does not exist, and never sees the
> `.env` you just filled in. The wrapper points `--env-file` at the real one.
> `--project-directory .` is not a substitute: it also re-roots every build
> context. The stacks now refuse to start rather than silently mounting
> `/mnt/hdd` when your disk is somewhere else.

**Jellyfin** — finish setup at `https://media.example.com`. Add two libraries:
`/media/local` (the HDD) and `/media/remote` (the StorageBox). Then create an
API key under Dashboard → API Keys, put it in `.env` as `JELLYFIN_API_KEY`, and
restart the dashboard so it can show streams and transcodes:

```bash
sudo ./scripts/compose.sh core up -d --force-recreate dashboard
```

**Immich** — finish setup at `https://photos.example.com`. The first account
you create is the admin. Install the mobile app on both phones and point it at
that URL, then turn on backup.

Two settings worth changing straight away, under Administration → Settings:

* **Job concurrency** — lower *Smart Search* and *Face Detection* to 1. The
  defaults assume a machine with more cores than this one.
* **Storage template** — leave it off unless you want Immich renaming files on
  disk. Off keeps the library legible to the tiering engine.

**Syncthing** — the web UI is at `https://sync.example.com`, VPN only. Add your
laptops by device ID and share `/var/syncthing/Sync`. Sync traffic goes
peer-to-peer on port 22000 and never passes through the proxy.

**Minecraft and the desktop** — build the images but leave them stopped:

```bash
sudo ./scripts/compose.sh games create
sudo ./scripts/compose.sh desktop create
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
sudo ./scripts/compose.sh core up -d --build
```

The database migrates itself on start. Migrations are append-only, so a
downgrade needs a restore from backup — the nightly job puts one on the
StorageBox.
