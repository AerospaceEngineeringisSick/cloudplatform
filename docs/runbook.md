# Runbook

What to do when something breaks. In rough order of likelihood.

## The StorageBox shows offline

The most common problem. An SFTP session dropped and the mount went stale.

```bash
systemctl status storagebox
journalctl -u storagebox -n 50 --no-pager
```

Usually a restart is enough:

```bash
sudo systemctl restart storagebox
mountpoint /mnt/storagebox && df -h /mnt/storagebox
```

If it refuses because the mount point is busy, something still holds a file
handle:

```bash
sudo fuser -mv /mnt/storagebox
sudo fusermount3 -uz /mnt/storagebox    # lazy unmount
sudo systemctl restart storagebox
```

If it will not connect at all, test the remote directly — the problem is
credentials or the network, not the mount:

```bash
sudo rclone lsd storagebox:
```

The dashboard survives this: `statfs` calls have a hard timeout, so a hung
mount shows as offline rather than freezing the page.

## Everything is slow

Check the Compute page first. The usual causes, in order:

**A Jellyfin transcode.** One 4K transcode can consume every core it is
allowed. Media → check the direct-play vs transcode split. Fix it properly by
making the client direct-play (correct container and codec); fix it right now by
switching to Media mode, or stopping the stream.

**Minecraft on the wrong profile.** If it is running while the machine is in
Normal mode, it is capped low and will feel awful. Switch to Gaming.

**The tiering sweep during something else.** Jobs → check whether `tier-sweep`
is running. Gaming and Media modes pause it automatically; if you are in Normal
and it is competing, pause it by hand.

**Memory pressure.** Overview → if swap is in use, something has an oversized
ceiling. Compute → Custom allocation, and check the total against 16 GiB.

## Compose says a variable is "missing a value"

```
error while interpolating services.dashboard.environment.SESSION_SECRET:
  required variable SESSION_SECRET is missing a value
```

Your `.env` is fine. The command is wrong:

```bash
docker compose -f stack/docker-compose.core.yml up -d      # reads stack/.env
sudo ./scripts/compose.sh core up -d                       # reads ./.env
```

Compose resolves `.env` against the **project directory**, and that defaults to
the directory holding the first `-f` file — `stack/`, not the repository root.
It never opens `/opt/cloudplatform/.env`.

`scripts/bootstrap.sh` used to hide this, because it exports the values into
its own environment before calling Compose. Anything typed by hand does not.

Two other fixes that look right and are not:

- `--project-directory .` moves the project root as well, so `build: ..` in the
  dashboard service resolves to the *parent* of the repository.
- Copying `.env` into `stack/` gives you two files to keep in step.

`docker compose --env-file .env -f stack/…` is exactly what the wrapper runs,
if you would rather type it.

**The silent version of this.** Only required variables announce themselves.
Defaulted ones do not: `HDD_PATH` used to fall back to `/mnt/hdd`, so Jellyfin
would start cleanly with empty libraries when the disk was at `/mnt/data`. The
three mount paths are now required for exactly this reason.

## A container will not start

```bash
docker ps -a
docker logs <name> --tail 100
```

Or Logs in the dashboard, which needs no SSH.

Common causes:

- **Port already bound.** `sudo ss -tlnp | grep <port>`
- **A volume path that does not exist.** Usually the StorageBox is unmounted —
  fix the mount first.
- **Out of memory.** `docker inspect <name> | grep -i oomkilled`. Raise the
  ceiling on the Compute page.
- **A permissions error on a mounted path.** Check `PUID`/`PGID` in `.env`
  against `id -u` and `id -g`.

## I cannot sign in

**Wrong code.** Almost always clock drift on the phone. The server accepts one
30-second step either side. Turn on automatic time on the phone.

**"Too many failed attempts."** Throttling, keyed on both account and address.
Wait it out — the message says how long — or clear it directly:

```bash
sudo docker exec -it dashboard node -e "
const D=require('better-sqlite3');const db=new D('/data/cloud.db');
console.log(db.prepare('DELETE FROM login_attempts').run());"
```

**Lost the authenticator.** Use a recovery code — on the 2FA screen, choose
*Use a recovery code*. Then set up TOTP again under Security and generate a new
set.

**Lost both.** Reset two-factor directly on the server:

```bash
sudo docker exec -it dashboard node -e "
const D=require('better-sqlite3');const db=new D('/data/cloud.db');
db.prepare(\"UPDATE users SET totp_enrolled=0, totp_last_step=0 WHERE username=?\").run('luke');
console.log('enrolment reset — sign in and enrol again');"
```

You will be asked to enrol on the next sign-in. Your password is still required.

**The panel does not resolve.** Check the VPN. `tailscale status` on both ends.
The dashboard is deliberately unreachable without it.

## Minecraft is laggy

Minecraft page, and read TPS and MSPT together:

| Reading | Meaning |
|---|---|
| TPS 20, MSPT under 30 | healthy |
| TPS 20, MSPT 40–50 | close to the edge; something is about to give |
| TPS below 19 | the server cannot keep up |

MSPT is the more useful number — it rises before TPS falls.

If MSPT is high with nobody online, something is wrong in the world: an entity
farm, a chunk loader, a broken redstone contraption. If it rises with player
count, it is genuine load — check that you are in Gaming mode, and that nothing
else heavy is running.

## Restoring from backup

```bash
# What is there
sudo rclone lsd storagebox:Backups/VPS

# Restore the dashboard database
sudo ./scripts/compose.sh core stop dashboard
sudo rclone copy storagebox:Backups/VPS/2026-01-15/cloud.db /tmp/
sudo docker run --rm -v cloud-core_dashboard-data:/data -v /tmp:/restore \
  alpine cp /restore/cloud.db /data/cloud.db
sudo ./scripts/compose.sh core start dashboard
```

For the Minecraft world:

```bash
sudo ./scripts/compose.sh games stop minecraft
sudo rclone copy storagebox:Backups/Minecraft/world-2026-01-15T04-00-00 /srv/minecraft
sudo ./scripts/compose.sh games start minecraft
```

Stop the service before restoring its data. Always.

## The Caddy image will not build

```
undefined: zaplog.HandlerOptions
failed to solve: process "/bin/sh -c xcaddy build ..." did not complete successfully
```

xcaddy compiles Caddy and its plugins as a single Go module graph, so an
unpinned plugin can pull a shared dependency forward past what the pinned
Caddy version compiles against. The error names a symbol inside Caddy's own
source, which makes it look like Caddy is broken; it is really a version skew.

`stack/caddy/Dockerfile` pins the Caddy version *and* both plugin versions for
exactly this reason. If you bump one, bump them together and rebuild:

```bash
sudo ./scripts/compose.sh core build --no-cache proxy
```

The image build ends with a `caddy list-modules` check, so a plugin that fails
to link breaks the build rather than surfacing as a mysterious 500 at runtime.

## Certificates will not issue

```bash
docker logs caddy --tail 50
```

- **Ports 80 and 443 must be reachable from the internet** for the HTTP
  challenge, including for `panel` and `host`. The 403 is applied by Caddy
  after the certificate is issued, so it does not interfere.
- **DNS must have propagated.** `dig +short panel.example.com`
- **Let's Encrypt rate limits** — five failures per account per hostname per
  hour. Uncomment the staging CA line in the Caddyfile while debugging.

## The disk filled up

```bash
df -h
sudo du -xh --max-depth=1 / | sort -rh | head -20
```

Usual suspects on the NVMe:

```bash
docker system prune -a --volumes       # careful: removes unused volumes
sudo du -sh /var/cache/rclone          # bounded by --vfs-cache-max-size
sudo journalctl --vacuum-size=200M
```

If the HDD is full, enable automatic tiering, or move something down by hand
from the Storage page.

## Health checks

```bash
# Is the API alive?
curl -s http://127.0.0.1:8787/api/health

# What is running?
docker ps --format 'table {{.Names}}\t{{.Status}}'

# Are the mounts up?
mountpoint /mnt/hdd && mountpoint /mnt/storagebox

# Dashboard logs
docker logs dashboard --tail 100
```

## Getting a shell into the dashboard

```bash
sudo docker exec -it dashboard sh
sqlite3 /data/cloud.db ".tables"      # if sqlite3 is installed
```

The database is plain SQLite. Back it up before editing it by hand.
