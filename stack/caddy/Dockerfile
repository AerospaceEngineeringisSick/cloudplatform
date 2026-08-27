# Caddy with two plugins the stock image does not carry.
#
#   caddy-dns/cloudflare  — DNS-01 certificate challenges, so certificates can
#                           be issued for hostnames that are not publicly
#                           reachable, and port 80 need never be exposed.
#   caddy-ratelimit       — throttles the login endpoints of the public
#                           services, which have no brute-force protection of
#                           their own.
FROM caddy:2.8-builder-alpine AS builder

RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare \
    --with github.com/mholt/caddy-ratelimit

FROM caddy:2.8-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Confirms the plugins actually made it into the binary.
RUN caddy list-modules | grep -q "dns.providers.cloudflare" \
 && caddy list-modules | grep -q "http.handlers.rate_limit"
