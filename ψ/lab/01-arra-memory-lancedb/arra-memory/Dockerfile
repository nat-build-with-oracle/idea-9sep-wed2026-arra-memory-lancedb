# Digest-pinned by DEFAULT: Supervisor 2026.04+ supplies no implicit BUILD_FROM,
# so an unpinned or absent base is a build that fails late rather than early.
#
# It is an ARG rather than a literal so the official Home Assistant builder can
# substitute the per-architecture base from build.yaml when publishing to ghcr.
# A plain `docker build` with no argument still gets the pinned digest, which is
# what makes a local verification build meaningful.
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.22@sha256:0eda502b4d16e0433ace512d857ec3e86497d4214091ee459078ee4df6373f63
FROM ${BUILD_FROM}

ARG BUILD_VERSION="dev"
ARG BUILD_ARCH="amd64"

LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="addon" \
    io.hass.arch="${BUILD_ARCH}"

# The HA base is Alpine, so Bun must be the musl build — the default glibc
# binary exits with "not found" here, which reads like a missing file rather
# than a libc mismatch and costs an hour if you have not seen it before.
RUN apk add --no-cache libstdc++ unzip curl jq \
 && case "${BUILD_ARCH}" in \
      amd64)   BUN_TARGET="bun-linux-x64-musl" ;; \
      aarch64) BUN_TARGET="bun-linux-aarch64-musl" ;; \
      *)       echo "unsupported arch: ${BUILD_ARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/${BUN_TARGET}.zip" -o /tmp/bun.zip \
 && unzip -q /tmp/bun.zip -d /tmp \
 && mv "/tmp/${BUN_TARGET}/bun" /usr/local/bin/bun \
 && chmod +x /usr/local/bin/bun \
 && rm -rf /tmp/bun.zip "/tmp/${BUN_TARGET}" \
 && bun --version

WORKDIR /app

# Dependencies first, so editing source does not re-resolve the whole tree.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
# scripts/ is part of the BUILD, not just tooling — build:ui runs
# sync-version.ts out of it. Omitting it fails the image build with
# "Module not found", which Supervisor then reports as a successful update
# that quietly leaves the previous version installed.
COPY scripts/ ./scripts/
# config.yaml is a BUILD INPUT, not just Supervisor's manifest: sync-version.ts
# reads the version out of it so the running server can state which build it is.
# It is the single source of truth precisely because Supervisor reads it too.
COPY config.yaml ./config.yaml

# The React bundle and the stylesheet are built into the image, never shipped
# in git — a built asset in a repo is a merge conflict waiting to happen.
RUN bun run build:ui \
 && test -s public/main.js \
 && test -s public/app.css

COPY run.sh /run.sh
RUN chmod 0755 /run.sh

CMD ["/run.sh"]
