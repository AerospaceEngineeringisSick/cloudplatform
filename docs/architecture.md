# Architecture

## The governing decision

Build the control layer; do not rebuild the infrastructure.

There are excellent tools for the hard parts — Docker for workloads, rclone for
remote storage, Caddy for TLS, Jellyfin for media, Nextcloud for files. What did
not exist was a control layer that understands *this specific machine*: four
cores that can only really do one heavy thing at a time, and three storage tiers
with wildly different characteristics.

So the dashboard owns policy, and delegates mechanism:

```
                     ┌──────────────────────────┐
                     │      the dashboard       │
                     │   policy and presentation│
                     └────────────┬─────────────┘
                                  │
        ┌───────────────┬─────────┼──────────┬──────────────┐
        ▼               ▼         ▼          ▼              ▼
   Docker API      /proc,statfs  rclone   Jellyfin API   RCON
   start/stop      telemetry     transfer  streams       players
   cgroup limits                 tiering   transcodes    TPS, console
```

Every one of those is a mature tool doing what it is good at. The dashboard
decides *when* and *how much*.

## Processes

Exactly two things run that we wrote:

- **The API** (`apps/api`) — one Node process. Fastify for HTTP, SQLite for
  state, dockerode for containers. It also serves the built dashboard, so a
  deployment is one container.
- **The dashboard** (`apps/web`) — a React single-page app. It holds no state
  the server does not; a refresh loses nothing.

They share `packages/shared`, which describes everything crossing the wire
exactly once. Change a field there and both sides fail to compile until they
agree — the wire contract cannot drift.

## Inside the API

```
index.ts            wiring, security headers, error handling, shutdown
  ├── auth/         argon2id, TOTP, WebAuthn, sessions, rate limiting
  ├── db/           SQLite, append-only migrations
  ├── metrics/      /proc collector, history, rollups
  ├── docker/       container client, background stats supervisor
  ├── profiles/     the resource allocation engine
  ├── storage/      path jail, browser, rclone transfers, tiering
  ├── services/     Jellyfin, Minecraft RCON, uptime monitor
  ├── jobs/         cron scheduler
  ├── routes/       the HTTP surface
  └── ws/           the live channel
```

Four long-lived background loops:

| Loop | Interval | Does |
|---|---|---|
| Collector | 2 s | Samples `/proc` and `statfs`; persists every 30 s |
| Supervisor | 5 s | Lists containers, samples Docker stats, detects Minecraft transitions |
| Monitor | 60 s | Runs availability checks |
| Scheduler | cron | Backups, tiering sweeps, library scans |

Each keeps a warm view and pushes to subscribers. Nothing in a request path
waits on Docker's slow stats endpoint or on a possibly-hung remote mount.

## The profile engine

The most interesting part, and the reason the machine feels bigger than it is.

Docker can change a running container's cgroup limits without recreating it.
That is what makes profile switching instant:

```
apply("gaming")
  │
  ├─ stops first, freeing CPU and RAM before anything claims it
  │    desktop → stop
  │
  ├─ then updates limits and starts
  │    minecraft → 3.25 cores, 8 GiB, shares 4096
  │    jellyfin  → 0.75 cores, 2 GiB, shares 512
  │
  └─ pauses the jobs the profile names
       backup-nightly, tier-sweep, media-scan
```

Three deliberate choices:

**Profiles address services by label, not by container name.** A container
carrying `cloud.service=jellyfin` is Jellyfin, whatever it is called and
whichever compose file defines it.

**Ceilings may sum above four cores.** A CPU quota is a hard cap, not a
reservation. Idle services never claim theirs, so overcommitting is correct;
`cpuShares` decides who wins when they all want it at once.

**Applying is best-effort per service.** One missing container must not prevent
the rest of the machine being reconfigured. Every outcome is reported back, and
a service that is not deployed is not an error — it is just absent.

Starting the Minecraft container flips the machine into Gaming without being
asked. The supervisor watches for the transition and only reverses an automatic
switch — a profile you chose by hand is left alone.

## Telemetry

Read straight from the kernel, no agent:

| Metric | Source |
|---|---|
| CPU, per-core | `/proc/stat`, deltas between samples |
| Memory | `/proc/meminfo` — `MemAvailable`, so cache is not counted as used |
| Disk usage | `fs.statfs`, with a hard timeout so a hung mount cannot stall a poll |
| Disk I/O | `/proc/diskstats` |
| Network | `/proc/net/dev` |
| Containers | Docker stats, sampled in the background |

Storage is two-tier to keep the database small: fine samples every 30 seconds
for 48 hours, then hourly rollups for 30 days. Short ranges read samples, long
ranges read rollups, and the query picks automatically.

The monthly transfer counter accumulates *deltas* rather than reading the
interface counter directly, so a reboot resetting `/proc` does not zero the
month.

## Storage tiering

```
       hot                    warm                   cold
   160 GB NVMe            1 TB local HDD        2 TB StorageBox
   ───────────            ──────────────        ───────────────
   OS, Docker             active media          Cloud/
   databases              downloads             Media/
   Minecraft world        projects              Archive/
   transcode cache        snapshots             Vault/   (encrypted)
   rclone cache                                 Backups/
        │                       │                     │
        └───────────────────────┴─────────────────────┘
                    one browsable filesystem
```

The sweep is deliberately timid. It runs only when the HDD is above its target
fill, moves the coldest and largest files first, stops at a per-run byte cap,
and never touches anything matching an exclude rule. It would rather do nothing
than saturate a link someone is streaming over.

Every path from the browser goes through `storage/paths.ts`, which resolves
symlinks and proves the result is still inside the mount. See
[security.md](security.md).

## The dashboard

State arrives over one WebSocket. Host, containers, profile, transfers, uptime
and jobs all stream on named channels; a `LiveProvider` fans them out to
components. HTTP is only for actions and for history queries.

Charts are hand-drawn SVG rather than a charting library — a few hundred lines
against ~90 KB of dependency, with exact control over the accessibility rules
the visuals hold to: values readable as text, a legend whenever two series share
a plot, one shared y-scale, and colour never carrying meaning alone.

The accent colour re-tints with the active profile, so the machine's mode is
felt at a glance. Chart series colours never change with it — data colour means
identity, not mood.

## Deliberate omissions

- **No agent.** Netdata is excellent, but everything shown here comes from
  `/proc` and the Docker API directly. One less moving part.
- **No ORM.** SQLite with hand-written SQL and append-only migrations.
- **No charting library.** See above.
- **No Kubernetes.** One machine.
- **No secrets in the browser.** Container environments are redacted server-side
  before they are ever sent.
