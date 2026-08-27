# The edge: Cloudflare, TLS and what is exposed

## Should you put Cloudflare in front of this?

**For DNS: yes. For the proxy — the orange cloud — mostly no.** Three of the
four hostnames are actively harmed by it, and the fourth gains little.

### What the orange cloud breaks here

**It breaks the VPN restriction outright.** The whole security model rests on
Caddy comparing the *connecting* address against your VPN range. Behind
Cloudflare, every request arrives from a Cloudflare address. The check then
matches nobody, and `panel`, `host` and `sync` return 403 to you as well. You
would have to trust `CF-Connecting-IP` to fix it — at which point anyone who
can reach your origin directly can forge that header and walk straight in.
The current design has no such bypass. Keep it that way.

**Video streaming is against their terms.** Cloudflare's self-serve terms
restrict using the CDN to serve a disproportionate amount of non-HTML content,
and video is the example they name. Plenty of people proxy Jellyfin anyway;
some of them get a notice. It is your call, but it is not a supported
configuration, and if it stops working you have no recourse.

**Uploads hit a wall.** The free plan caps request bodies at 100 MB. Immich
chunks large uploads, so it survives, but a single large file through any other
path will fail with a 413 that looks like an application bug.

### What Cloudflare is genuinely good for here

Use it as your **DNS provider** with every record grey-clouded (DNS-only), and
take the one feature that is a real improvement: **DNS-01 certificates.**

```
CADDYFILE=Caddyfile.dns
CLOUDFLARE_API_TOKEN=<token>
```

Create the token with exactly one permission — **Zone → DNS → Edit**, scoped to
your zone alone. It cannot read traffic and cannot change anything else.

That buys you three things:

| | With HTTP-01 (default) | With DNS-01 |
|---|---|---|
| Port 80 open to the internet | required | **not needed** |
| `panel` / `host` in public DNS | required | **not needed** |
| Wildcard certificates | no | yes |

The second row is the interesting one. With DNS-01 you can delete the public
`panel` and `host` records entirely and resolve them through Tailscale's
MagicDNS instead. The control plane then stops being *refused* from the
internet and starts being *unreachable* — there is no address to attack.

That is a strictly better posture than anything the orange cloud offers.

### If you want DDoS protection anyway

You have a 10 Gbps link and an 80 TB allowance. The realistic risk is not
someone knocking you offline; it is someone burning your transfer. Watch the
allowance counter on the Network page, and set `RCLONE_BWLIMIT` so background
tiering cannot compound a bad month.

If you later decide you do want Cloudflare in front of the *public* services
only, proxy `photos` and leave `media` direct — that keeps you inside their
terms and away from the upload cap on the service that needs it most.

## Certificate issuance

Both variants live in `stack/caddy/`. They share `sites.caddy` and differ only
in the global block, so there is one place to change a route.

Switch between them with `CADDYFILE` in `.env`; the container reloads with the
selected file on the next `up -d`.

While debugging, uncomment the staging CA line so you cannot exhaust Let's
Encrypt's rate limit — five failures per hostname per hour, and the lockout is
long enough to ruin an evening.

## What is exposed, precisely

| Hostname | Public | Notes |
|---|---|---|
| `media` | yes | Streaming only; admin surface returns 403 off-VPN |
| `photos` | yes | Immich, rate-limited login |
| `panel` | **no** | Dashboard. 403 off-VPN, or absent entirely with DNS-01 |
| `host` | **no** | Raw host tools |
| `sync` | **no** | Syncthing's web UI |
| `:22000` | yes | Syncthing peer-to-peer sync. Not HTTP, not proxied |
| `:25565` | yes | Minecraft. Only while the server is running |

Everything else on the machine listens on loopback.
