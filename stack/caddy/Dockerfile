# Caddy with two plugins the stock image does not carry.
#
#   caddy-dns/cloudflare  — DNS-01 certificate challenges, so certificates can
#                           be issued for hostnames that are not publicly
#                           reachable, and port 80 need never be exposed.
#   caddy-ratelimit       — throttles the login endpoints of the public
#                           services, which have no brute-force protection of
#                           their own.
#
# Everything here is pinned deliberately. xcaddy resolves the Caddy source and
# the plugins as one Go module graph, so an unpinned plugin can pull in a newer
# shared dependency than the pinned Caddy compiles against. That is not
# hypothetical: on Caddy 2.8.4 a current caddy-ratelimit drags in a
# go.uber.org/zap/exp that no longer exports zapslog.HandlerOptions, and the
# build dies with "undefined: zaplog.HandlerOptions" inside Caddy's own
# context.go. Pinning all three keeps the graph reproducible.
#
# Verified: this combination compiles, and both modules appear in
# `caddy list-modules`.

FROM caddy:2.11.4-builder-alpine AS builder

RUN xcaddy build v2.11.4 \
    --with github.com/caddy-dns/cloudflare@v0.2.4 \
    --with github.com/mholt/caddy-ratelimit@v0.1.0

FROM caddy:2.11.4-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Fail the image build, not the first request, if a plugin silently went missing.
RUN caddy list-modules | grep -q "dns.providers.cloudflare" \
 && caddy list-modules | grep -q "http.handlers.rate_limit" \
 && caddy version
