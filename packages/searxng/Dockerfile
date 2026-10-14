# SearXNG, the metasearch engine /v1/search discovers the public web through.
#
# It runs as a sidecar in the clarity-api task (oxy-infra `app-clarity.tf`) and
# answers only on 127.0.0.1: nothing outside the task can reach it, and it holds
# no credential — every engine it asks is keyless.
#
# Pinned by digest to the release that was proven from inside the VPC. Engines
# change their pages and SearXNG follows, so bumping this is routine upkeep.
FROM docker.io/searxng/searxng:2026.9.23-3cd69d30e@sha256:bcfaed4091d59f7ce85670bd701a2d0295872196dc19908a3965a8353b149f83

# It runs as upstream's own unprivileged user, `searxng` (uid/gid 977, from the
# base image's /etc/passwd), never as root: it parses untrusted HTML from the
# web inside the API's task.
#
# Upstream's entrypoint (container/entrypoint.sh at 3cd69d30e) writes
# `$__SEARXNG_CONFIG_PATH/settings.yml` from the template on every start, and
# the image declares that directory (/etc/searxng) and /var/cache/searxng as
# VOLUMEs. Docker seeds a fresh volume with the image's 977-owned directory,
# but a runtime that mounts its own empty, root-owned directory there (Fargate
# may) leaves a non-root entrypoint unable to write the settings: it exits 127,
# and because the sidecar is non-essential the API would keep serving with web
# discovery silently gone. So the settings live in a directory this image
# creates, owned by searxng, that is NOT a volume:
#   - __SEARXNG_CONFIG_PATH / __SEARXNG_DATA_PATH are what the entrypoint reads
#     (it checks both directories and writes the settings into the first);
#   - SEARXNG_SETTINGS_PATH is what searx itself reads (searx/settings_loader.py),
#     and naming the file makes a missing file a startup error rather than a
#     silent fall-back to upstream's defaults (which would refuse to run on
#     the default secret key, and serve no JSON).
# The two VOLUMEs stay declared (a child image cannot remove them) and unused.
# searx's own caches go to tempfile.gettempdir(), /tmp (1777 in the base).
# CI's image smoke runs it with fresh volumes AND with root-owned ones mounted
# at both VOLUME paths, and asserts /healthz, JSON search and our settings.
RUN install -d -m 0700 -o searxng -g searxng \
      /var/lib/searxng /var/lib/searxng/config /var/lib/searxng/data

# The image's entrypoint copies its settings TEMPLATE into place on start and
# replaces `ultrasecretkey` with fresh random bytes, so the secret is per task
# and never stored anywhere. Owned by searxng like the rest of upstream's
# /usr/local/searxng: the entrypoint copies it with `cp -p`, which as a
# non-root user cannot preserve a root owner.
COPY --chown=977:977 settings.yml /usr/local/searxng/settings.template.yml

ENV __SEARXNG_CONFIG_PATH=/var/lib/searxng/config \
    __SEARXNG_DATA_PATH=/var/lib/searxng/data \
    SEARXNG_SETTINGS_PATH=/var/lib/searxng/config/settings.yml \
    GRANIAN_HOST=127.0.0.1 \
    GRANIAN_PORT=8080

USER searxng:searxng
