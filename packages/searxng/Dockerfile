# SearXNG, the metasearch engine /v1/search discovers the public web through.
#
# It runs as a sidecar in the clarity-api task (oxy-infra `app-clarity.tf`) and
# answers only on 127.0.0.1: nothing outside the task can reach it, and it holds
# no credential — every engine it asks is keyless.
#
# Pinned by digest to the release that was proven from inside the VPC. Engines
# change their pages and SearXNG follows, so bumping this is routine upkeep.
FROM docker.io/searxng/searxng:2026.9.23-3cd69d30e@sha256:bcfaed4091d59f7ce85670bd701a2d0295872196dc19908a3965a8353b149f83

# The image's entrypoint copies its settings TEMPLATE into place on start and
# replaces `ultrasecretkey` with fresh random bytes, so the secret is per task
# and never stored anywhere.
COPY --chown=977:977 settings.yml /usr/local/searxng/settings.template.yml

ENV GRANIAN_HOST=127.0.0.1 \
    GRANIAN_PORT=8080
