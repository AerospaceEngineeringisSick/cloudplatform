# Personal Cloud Platform

A control centre for one small, well-specified server — built so that a
4 vCPU / 16 GiB VPS with three very different storage tiers behaves like a
single coherent machine rather than a pile of containers.

The idea is deliberately narrow: **build the control layer, not the
infrastructure.** Docker runs the workloads, rclone moves the bytes, Caddy
terminates TLS, Jellyfin serves media, Immich holds the photos. This repository
is the one thing that did not already exist — a dashboard that understands
*this* hardware and gives it a single set of controls.

```
                    THE DASHBOARD
   ┌──────────────────────────────────────────────┐
   │  CPU │ RAM │ Storage │ Network │ Uptime      │
   │                                              │
   │ NORMAL  GAMING  MEDIA  DESKTOP  QUIET  CUSTOM │
   │     └────────── one click ──────────┘        │
   └───────┬──────────┬──────────┬────────────────┘
           │          │          │
      Docker API   /proc      rclone / SFTP
           │          │          │
           └──────────┴──────────┘
                      │
         EPYC 9655 · 4 vCPU · 16 GiB · 10 Gbps
      160 GB NVMe  +  1 TB HDD  +  2 TB StorageBox
```

## What it does that a stock panel does not

**Resource profiles.** The machine has four cores. Rather than dividing them
permanently, you pick what the machine is *for* right now and every container's
CPU and memory ceiling is rewritten live — no restart, no redeploy.

| Profile | Minecraft | Jellyfin | Photo analysis | Background jobs |
|---|---|---|---|---|
| **Normal** | off | 2.0 cores | running | running |
| **Gaming** | 3.25 cores, 8 GiB | 0.75 cores | stopped | paused |
| **Media** | off | 3.5 cores, transcoding | stopped | tiering paused |
| **Desktop** | off | 1.0 core | stopped | tiering paused |
| **Quiet** | off | off | stopped | media scan paused |
| **Custom** | your sliders | | | |

Immich is split in two so this works: uploads keep arriving in every profile,
while the face-recognition worker — the expensive half — stops whenever the
machine has something better to do.

Starting Minecraft switches to Gaming by itself. Stopping it hands the
resources straight back. Nothing is wasted while you are not playing.

**Real tiered storage.** The StorageBox is not just a backup target — it is the
cold tier of a three-tier filesystem, mounted over SFTP and browsable from the
dashboard like any other disk.

| Tier | Size | Holds | Speed |
|---|---|---|---|
| **Hot** — NVMe | 160 GB | OS, databases, container state, live Minecraft world, transcode cache | fastest |
| **Warm** — HDD | 1 TB | active media, downloads, projects, local snapshots | fast |
| **Cold** — StorageBox | 2 TB | cloud files, archive, encrypted vault, backups | remote |

Files untouched for 90 days migrate down automatically. The sweep is bounded so
it cannot saturate the link, and Jellyfin keeps playing files that have moved —
they stream from the StorageBox.

**Two-factor authentication that is actually mandatory.** Not an option buried
in settings: the platform stays locked until enrolment is finished.

## Quick start

```bash
git clone <this-repo> /opt/cloudplatform
cd /opt/cloudplatform

sudo ./scripts/bootstrap.sh      # writes .env, generates a session secret
$EDITOR .env                     # set DOMAIN, ACME_EMAIL and the passwords
sudo ./scripts/storagebox-mount.sh
sudo ./scripts/bootstrap.sh      # builds and starts the core stack
```

Then open `https://panel.<your-domain>` **over your VPN** and create the owner
account. Bring up the rest as you want it:

```bash
sudo ./scripts/compose.sh media up -d   # Jellyfin
sudo ./scripts/compose.sh cloud up -d   # Immich + Syncthing
```

Leave Minecraft and the desktop stopped — the dashboard starts those on demand.

Full walkthrough: **[docs/install.md](docs/install.md)**.

## The pages

| | |
|---|---|
| **Overview** | Live gauges, storage tiers, transfer allowance, 30-day availability |
| **Compute** | Per-core load, profile switching, custom allocation sliders |
| **Containers** | Every workload, live usage, logs, start/stop/restart |
| **Minecraft** | Players, TPS, MSPT, world size, backups, RCON console |
| **Media** | Streams, and the direct-play vs transcode split that decides your CPU |
| **Cloud** | Immich and Syncthing, and how the tiers feed them |
| **Storage** | Three-tier browser, transfers between tiers, automatic tiering rules |
| **Desktops** | On-demand browser desktop |
| **Network** | Throughput and the 80 TB monthly allowance, with a projection |
| **Monitoring** | Host history over 1h / 24h / 7d / 30d, availability checks |
| **Jobs** | Scheduled backups, tiering sweeps, library scans |
| **Logs** | Container output |
| **Security** | Accounts, passkeys, sessions, recovery codes, audit trail |
| **Settings** | How this instance is configured |

## Security posture

The split is the point:

- **Public**, with automatic HTTPS — Jellyfin and Immich. Share a link; back up
  photos from a phone without the VPN. Their *administrative* surfaces are not
  public: Jellyfin's plugin, config and log endpoints return 403 off-VPN, login
  endpoints are rate-limited, and account enumeration is closed.
- **VPN only** — the dashboard, Syncthing's UI, and anything that can change the
  machine. A leaked dashboard password is not enough, because nothing routes
  there from the internet.

Do not put Cloudflare's proxy in front of the private hostnames — it replaces
the client address that check depends on. See [edge.md](docs/edge.md).

On top of that: argon2id password hashing, mandatory TOTP with replay
protection, optional passkeys, single-use recovery codes, hashed session
tokens, login throttling keyed on both account and source address, CSRF origin
checks, a strict CSP, a path-jailed file browser, and a full audit log. Anything
destructive asks for a fresh second factor.

Details and the threat model: **[docs/security.md](docs/security.md)**.

## Development

```bash
npm install
npm run build
npm test                          # unit tests

npm run dev:api                   # API on :8787
npm run dev:web                   # dashboard on :5173, proxying the API
```

Two integration harnesses run the real server against a throwaway database:

```bash
./scripts/smoke-test.sh apps/api/tests/auth-flow.check.mjs      # auth, end to end
SERVE_WEB=true ./scripts/smoke-test.sh scripts/ui-check.mjs     # browser, all pages
```

| Layer | What it is |
|---|---|
| `packages/shared` | Types shared by the API and the dashboard — the wire contract, written once |
| `stack/caddy` | Two Caddyfile variants sharing one `sites.caddy`, plus the plugin build |
| `apps/api` | Fastify, SQLite, dockerode. No ORM, no framework magic |
| `apps/web` | React and Vite. Charts are hand-drawn SVG, no charting library |
| `stack/` | Compose files and the Caddy configuration |
| `scripts/` | Installer, the `docker compose` wrapper, StorageBox mount, test harnesses |

## Documentation

- **[install.md](docs/install.md)** — full setup, DNS, VPN, first run
- **[edge.md](docs/edge.md)** — Cloudflare, certificates, what is exposed
- **[architecture.md](docs/architecture.md)** — how the pieces fit, and why
- **[storage.md](docs/storage.md)** — the three tiers, rclone, automatic tiering
- **[security.md](docs/security.md)** — threat model and every control
- **[runbook.md](docs/runbook.md)** — when something breaks

## Licence

MIT. See [LICENSE](LICENSE).
