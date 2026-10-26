FROM node:24.22.1-bookworm-slim

# Use an openwork-server release that runs OpenCode v2 itself (no separate
# engine binary to install).
ARG OPENWORK_SERVER_VERSION=0.18.4

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    tar \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "openwork-server@${OPENWORK_SERVER_VERSION}"

# No engine is baked here: the npm package carries its own pinned OpenCode v2
# artifact manifest, and the server downloads that exact archive, checks its
# integrity, and caches it under OPENWORK_DATA_DIR (the /data volume) on first
# start. Set OPENWORK_OPENCODE2_BIN to use a binary you provide instead.

# Persistent directories (mount volumes here on PaaS/SSH).
# The data path deliberately keeps its historical name: existing deployments
# have volumes mounted at /data/openwork-orchestrator, and renaming it here
# would silently orphan their state. The orchestrator CLI itself is gone; this
# is only a directory name kept for compatibility.
ENV OPENWORK_DATA_DIR=/data/openwork-orchestrator
ENV OPENWORK_SIDECAR_DIR=/data/sidecars

# The workspace is mounted from the host/volume.
ENV OPENWORK_WORKSPACE=/workspace

# OpenWork host contract surface.
EXPOSE 8787

VOLUME ["/workspace", "/data"]

# Defaults:
# - OpenWork server is published intentionally via --host 0.0.0.0
# - OpenCode v2 is run by openwork-server and stays internal
CMD ["/bin/sh", "-lc", "plugin_dir=\"$(npm root -g)/openwork-server/dist/opencode-plugins\"; test -d \"$plugin_dir\"; export OPENWORK_EXTENSIONS_PLUGIN_DIR=\"$plugin_dir\"; exec openwork-server --workspace \"${OPENWORK_WORKSPACE:-/workspace}\" --host 0.0.0.0 --port \"${OPENWORK_PORT:-8787}\" --cors \"${OPENWORK_CORS_ORIGINS:-*}\" --approval \"${OPENWORK_APPROVAL_MODE:-manual}\""]
