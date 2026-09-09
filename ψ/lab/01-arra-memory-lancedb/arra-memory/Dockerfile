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

COPY package.json bun.lock tsconfig.json config.yaml ./
COPY src/ ./src/
COPY public/ ./public/
# scripts/ is part of the BUILD, not just tooling — build:ui runs
# sync-version.ts out of it. Omitting it fails the image build with
# "Module not found", which Supervisor then reports as a successful update
# that quietly leaves the previous version installed.
COPY scripts/ ./scripts/

# Install, build the UI, and shed what neither step leaves behind — all in ONE
# layer, because that is the only kind of deletion that makes an image smaller.
# A `rm -rf` in a later RUN records a whiteout over bytes the earlier layer
# still carries, so the download and the disk cost stay exactly the same.
#
# What is shed, and why it is safe:
#   onnxruntime-node, @huggingface/transformers, openai — 220MB of ML runtime
#     that @lancedb/lancedb lists as OPTIONAL dependencies for its built-in
#     embedding registry. This add-on never imports lancedb/embedding/*; its
#     vectors come from Ollama over HTTP (embedding.ts). Optionals cannot be
#     skipped wholesale with --omit=optional: that also drops lancedb's own
#     native binding AND @tailwindcss/oxide, and the build then fails in the
#     stylesheet step with npm's "optional dependencies bug" message.
#   devDependencies — tailwind, typescript and the type packages exist to
#     produce public/app.css and public/main.js, which by this point are built.
#     `--production` reconciles node_modules down to the runtime set.
#   lancedb-linux-*-gnu — os/cpu matching does not consider libc, so Bun
#     installs BOTH the gnu and the musl binding on Alpine and the gnu one can
#     never load here. Measured on ghcr.io/home-assistant/aarch64-base:3.22.
# The `test` lines turn a silently missing native binding or an empty bundle
# into a failed build rather than a container that dies on first request, and
# the `bun -e` actually dlopens the binding — the one check that proves musl
# rather than merely proving a directory exists.
RUN bun install --frozen-lockfile \
 && test -d node_modules/@lancedb/lancedb-linux-*-musl \
 && bun run build:ui \
 && test -s public/main.js \
 && test -s public/app.css \
 && bun install --frozen-lockfile --production \
 && rm -rf node_modules/onnxruntime-node node_modules/@huggingface node_modules/openai \
           node_modules/@lancedb/lancedb-linux-*-gnu \
 && test -d node_modules/@lancedb/lancedb-linux-*-musl \
 && bun -e 'const l = await import("@lancedb/lancedb"); const d = await l.connect("/tmp/probe"); await d.tableNames()' \
 && rm -rf /root/.bun/install/cache /tmp/*

COPY run.sh /run.sh
RUN chmod 0755 /run.sh

CMD ["/run.sh"]
