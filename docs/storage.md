# Storage

Three tiers, ~3.16 TB total, with very different characteristics. Using them
well is most of what makes this machine feel larger than it is.

| | NVMe | Local HDD | StorageBox |
|---|---|---|---|
| Size | 160 GB | 1 TB | 2 TB |
| Latency | microseconds | milliseconds | tens of milliseconds |
| Throughput | GB/s | ~150 MB/s | link-limited |
| Cost | included | included | ~£22/year |
| Good for | state, databases, caches | active working set | bulk, archive, backups |
| Bad for | anything large and cold | anything latency-critical | anything chatty |

## What goes where

**Tier 0 — NVMe.** Everything latency-sensitive or write-heavy:

```
/                     OS, Docker images and layers
/var/lib/docker       container state
/srv/minecraft        the live world — chunk writes are constant
/var/cache/jellyfin   transcode scratch
/var/cache/rclone     the StorageBox VFS cache
/var/lib/immich/postgres  the photo database — Immich does not support this
                          on a network share, and it would be unusable there
/data                 the dashboard's own database
```

The Minecraft world and the Jellyfin transcode cache are the two that matter
most. Both write constantly; on the HDD they would be a bottleneck, and on the
StorageBox they would be unusable.

**Tier 1 — local HDD.** The working set:

```
/mnt/hdd/Media/       what you are currently watching
/mnt/hdd/Photos/      Immich's library
/mnt/hdd/Sync/        Syncthing's shared folders
/mnt/hdd/Downloads/   staging
/mnt/hdd/Projects/    active code and large project files
/mnt/hdd/Snapshots/   local restore points
```

**Tier 2 — StorageBox.** Not just backups:

```
/mnt/storagebox/
├── Cloud/         Documents, Photos, Videos, Shared
├── Media/         Movies, TV, Music — the long tail
├── Archive/       old projects, ISOs, large files
├── Vault/         encrypted, unreadable to the provider
└── Backups/       VPS, Minecraft, Websites, Databases
```

Treating 2 TB as backup-only wastes most of it. It is bulk storage that happens
to be remote.

## The mount

```
StorageBox ──SFTP──▶ rclone ──FUSE──▶ /mnt/storagebox
```

`scripts/storagebox-mount.sh` installs a systemd unit. The flags that matter:

| Flag | Why |
|---|---|
| `--vfs-cache-mode full` | Lets files be opened for random read and write. Anything less breaks Jellyfin seeking |
| `--vfs-cache-max-size 20G` | Caps the NVMe cache so it cannot fill the boot disk |
| `--dir-cache-time 72h` | Directory listings over SFTP are slow; cache them hard |
| `--poll-interval 15s` | Still notice changes made elsewhere |
| `--vfs-read-chunk-size 32M` | Streaming reads large sequential chunks, not thousands of small ones |
| `--allow-other` | Containers run as other users and must read the mount |
| `--transfers 4` | The StorageBox is happiest around four parallel streams |

`Restart=on-failure` means a dropped connection reconnects on its own.

### The encrypted vault

`stack/rclone.conf.example` defines a `vault` crypt remote over
`storagebox:Vault`. Files written through it are encrypted client-side, with
encrypted filenames — the provider sees only ciphertext and sizes.

```bash
rclone copy /mnt/hdd/private vault:private
rclone mount vault: /mnt/vault --vfs-cache-mode full
```

Keep the crypt passwords somewhere other than the server. Lose them and the
data is gone.

## Automatic tiering

The dashboard's Storage page runs a nightly sweep:

```
  file on the HDD
        │
        ├─ smaller than the minimum size?         → leave it
        ├─ matches an exclude rule?               → leave it
        ├─ touched within the cold-after window?  → leave it
        │
        ▼
   candidate: coldest and largest first
        │
        ├─ HDD already under its target fill?     → stop, nothing to do
        ├─ per-run byte cap reached?              → stop
        │
        ▼
   rclone move → StorageBox, mirroring the same path
```

Defaults: off until you enable it, 90 days, files over 256 MiB, keep the HDD
under 75% full, at most 200 GiB per run.

Every guard is deliberate. It would rather do nothing than saturate a link
someone is streaming over, and it never moves a file so small that the round
trip costs more than the space saved.

Files that have moved stay playable — Jellyfin streams them from the
StorageBox, and the VFS cache makes seeking work.

### Moving things by hand

Storage → any file → **Move**, then pick a destination tier. Transfers run
through rclone with resume and checksum verification, and show live progress.
At most two run at once.

## Backups

The nightly job copies the dashboard database, container configuration and
Minecraft world to `Backups/` on the StorageBox. The Minecraft backup pauses
world saving first (`save-off`, `save-all flush`) so the copy is consistent
rather than a torn snapshot, and re-enables saving even if the copy fails.

**The gap worth knowing about:** these backups live on storage the server
itself can write to. Ransomware or a compromised host could delete them. If
that matters to you, add a second remote with append-only credentials and push
there too. The nightly job is a single `rclone copy` — adding a second
destination is one line in `apps/api/src/jobs/scheduler.ts`.

## Capacity planning

Watch two numbers on the Overview page:

- **NVMe.** The tightest tier at 160 GB. Docker images and the rclone cache both
  grow quietly. `docker system prune` reclaims the first;
  `--vfs-cache-max-size` bounds the second.
- **Monthly transfer.** 80 TB sounds enormous, but at a full 10 Gbps it is about
  eighteen hours. Streaming from the StorageBox counts against it twice — once
  in, once out. The Network page projects the month's total from the current
  rate.
