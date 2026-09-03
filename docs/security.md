# Security

## Threat model

Two people run this. It holds personal files, media, and a machine with a
10 Gbps link that would be valuable to someone else. The realistic threats, in
order:

1. **Credential stuffing and password spraying.** The most likely attack by a
   wide margin, and entirely automated.
2. **A stolen session** — a laptop left unlocked, a cookie lifted from a device.
3. **Path traversal through the file browser**, reaching outside the mounts.
4. **Command injection** through a filename, a Minecraft command, or a path.
5. **A compromised container** trying to reach the host.

Not in scope: a determined attacker with physical access to the datacentre, or
a supply-chain compromise of Debian or Docker Hub.

## The public / private split

This is the single most valuable control, and it is architectural rather than
a setting:

```
  internet ──▶ Caddy ──┬──▶ media.example.com    Jellyfin    public, hardened
                       ├──▶ photos.example.com   Immich      public, hardened
                       │
                       ├──▶ panel.example.com    dashboard   403 unless VPN
                       ├──▶ sync.example.com     Syncthing   403 unless VPN
                       └──▶ host.example.com     Cockpit     403 unless VPN
```

The dashboard binds to `127.0.0.1` and is published only through Caddy, which
refuses any request whose source address is outside the VPN range. **A leaked
dashboard password is not enough to reach the dashboard**, because nothing
routes there from the internet.

Jellyfin and Immich are public on purpose — a media link you cannot share, and
a phone that cannot back up photos without a VPN, are not worth the security.
But "public" here does not mean "wide open": see **Hardening the public
services** below.

Putting Cloudflare's proxy in front of the private hostnames would break this
outright, because the address Caddy compares would become Cloudflare's rather
than yours. See [edge.md](edge.md).

## Hardening the public services

Two applications face the internet, and neither ships with brute-force
protection. Both are narrowed at the proxy rather than trusted as-is.

**Jellyfin's administrative surface is pulled behind the VPN.** Plugin
installation is remote code execution by design, so these paths return 403 to
anyone off-VPN:

```
/System/Configuration*   /System/Restart   /System/Shutdown
/System/Logs*            /ScheduledTasks*  /Plugins*
/Repositories*           /Startup*         /Auth/Keys*
/Users/New               /Users/Delete*    /metrics
```

None of that is used by playback, so every client — phone, TV, browser —
keeps working. Administration happens over the VPN.

**Account enumeration is closed.** `/Users/Public` normally returns the list of
account names so a client can show a login picker. Off-VPN it now returns an
empty list, so clients ask for a typed username and an attacker learns nothing.

**Login endpoints are rate-limited** at the proxy — ten attempts per minute per
address for both `/Users/AuthenticateByName` and Immich's `/api/auth/login`.
Neither application does this itself.

**Request bodies are capped.** Jellyfin's public path accepts 10 MB, which is
far more than playback ever sends and removes a whole class of abuse. Immich is
allowed 50 GB because phone video genuinely is that large.

The residual risk is a weak Jellyfin password. Both accounts should use a
password manager; Jellyfin has no second factor, which is precisely why its
admin surface is not reachable from the internet.

## Authentication

**Passwords.** argon2id at OWASP's 2024 baseline — 19 MiB, 2 iterations, 1 lane.
Comfortably under a second on an EPYC core, and expensive for a GPU. A minimum
of twelve characters, with the handful of catastrophically common choices
rejected. No composition rules, because they mostly produce `Password1!`.

**TOTP is mandatory.** Not a setting: an account without it can reach the
enrolment page and nothing else. Standard RFC 6238, verified against the
specification's own test vectors.

Two details that are commonly missed:

- **Replay protection.** Each account records the last counter step it
  consumed, and a step is never accepted twice. Without this a code stays valid
  for its whole 30-second window and anyone who observes it can reuse it.
- **A one-step drift window either side**, and no more. Enough for a phone
  whose clock is slightly off; not a meaningfully larger guessing surface.

**Passkeys** (WebAuthn) are optional and phishing-resistant. Credentials are
bound to the exact origin. The signature counter must advance on every use — a
counter that does not is evidence of a cloned authenticator, and the sign-in is
refused.

**Recovery codes.** Ten, single-use, shown exactly once. Only SHA-256 digests
are stored; the plaintext cannot be recovered from a database dump. They carry
full entropy already, so a fast hash is the right choice — unlike a password,
there is nothing to slow a guesser down about.

**Sessions.** A 256-bit random token in an `HttpOnly`, `SameSite=Lax`,
`Secure` cookie, prefixed `__Host-` when on HTTPS. Only the SHA-256 digest is
stored, so a database leak is not a set of live logins. Changing a password
revokes every other session.

**Step-up.** Deleting files, removing a passkey, deleting an account,
regenerating recovery codes and similar actions require a second factor entered
within the last fifteen minutes. A stolen session cookie alone cannot wipe a
disk.

## Rate limiting

Login throttling is keyed on **both** the account and the source address:

- Account only → anyone can lock you out of your own machine.
- Address only → a botnet sprays one weak password across both accounts.

Eight failures in fifteen minutes and that key is refused, with a `Retry-After`
telling an honest client when to come back. A genuine success clears the budget.

Failure responses are identical whether or not the account exists.

## The path jail

Every path the file browser touches goes through one resolver, which:

1. Rejects null bytes and absolute paths before touching the filesystem.
2. Joins against the mount root and normalises, collapsing `..`.
3. Verifies the result is still under the root.
4. **Resolves symlinks and checks again** — otherwise a link pointing at `/etc`
   is a complete bypass.

Both steps matter. Step 3 alone is defeated by a symlink; step 4 alone cannot
handle paths that do not exist yet.

Verified in `apps/api/tests/security.test.mjs` against traversal, deep
traversal, traversal via symlink, symlinks pointing outside the mount,
dangling symlinks, absolute paths and null bytes. The property asserted is
containment rather than "throws an error" — a directory legitimately named
`....` must resolve normally, and does.

Deleting a mount root is refused outright.

## Command injection

Every external process — rclone, backup steps — is spawned with an **argument
array**, never a shell string. A filename containing `; rm -rf /` is a
filename, not a command.

The Minecraft console is a real RCON console, but `stop`, `op` and `deop` are
blocked there: stopping should go through the button that flushes the world
first, and privilege changes should be deliberate rather than a one-liner.

## Secrets

Container environments routinely hold passwords. The API redacts any variable
whose name matches `PASS|SECRET|TOKEN|KEY|CREDENTIAL|AUTH|PWD|SALT|PRIVATE`
**server-side**, before it is ever sent to the browser.

`SESSION_SECRET` may be supplied as `SESSION_SECRET_FILE` pointing at a file, so
it need not appear in the environment at all. In production the API refuses to
start without one rather than inventing a value that would change on restart.

## Browser hardening

Set on every response:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'`, no inline scripts, `frame-ancestors 'none'`, `object-src 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `same-origin` |
| `Strict-Transport-Security` | one year, when served over HTTPS |
| `Permissions-Policy` | geolocation, microphone and camera all denied |

CSRF is handled by `SameSite=Lax` cookies plus an `Origin` check on every state
-changing request. Requests with no `Origin` header — curl, scripts — are
allowed, since they carry no ambient browser credentials.

## The audit log

Every meaningful action is recorded with actor, action, target, source address
and outcome: sign-ins and failures, 2FA attempts, profile changes, container
control, file deletion, transfers, account changes. Visible under Security, and
kept in SQLite alongside everything else, so it is captured by the nightly
backup.

## Known trade-offs

**The dashboard mounts the Docker socket.** That is effectively root on the
host. It is the price of live container control. If you want to reduce it, put
a socket proxy such as `tecnativa/docker-socket-proxy` in front and grant only
`CONTAINERS`, `POST` and `INFO`. The dashboard needs container list, inspect,
start, stop, restart, update and logs — nothing else.

**Public services are public.** Jellyfin and Immich are exposed by design, and
neither supports two-factor authentication. The proxy narrows what they expose
and throttles their logins, but a weak password on either is still the softest
route in. Keep them updated; they are the front door.

**The browser desktop is root-capable.** It is reachable only over the VPN and
password-protected, but anyone who reaches it has a real Linux desktop on your
server. Set `DESKTOP_PASSWORD` to something serious.

**`--allow-other` on the rclone mount.** Required so containers can read it.
Any local user can then read the mount, which on a two-person server with no
other accounts is acceptable.

## If something is compromised

1. `sudo ./scripts/compose.sh core stop dashboard` — the
   control plane is the crown jewels.
2. Revoke every session: Security → Active sessions, or delete all rows from
   `sessions` in `/data/cloud.db`.
3. Change passwords, regenerate recovery codes, remove unknown passkeys.
4. Read the audit log for what was done and when.
5. Rotate `SESSION_SECRET`, the Minecraft RCON password, the Immich database
   password, the StorageBox key, and any Cloudflare API token.
6. Check `Backups/` on the StorageBox — it is the one thing an attacker with
   host access can also reach. If you want backups an attacker cannot delete,
   push them to a second remote with append-only credentials.
