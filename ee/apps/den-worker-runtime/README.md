# Den Worker Runtime Root

Render worker services use this directory as `rootDir`.

The control plane installs `openwork-server` during the Render build and then launches workers with the `openwork-server` command.

`openwork-server` runs the OpenCode v2 engine itself. It uses `OPENWORK_OPENCODE2_BIN` when set, then `opencode2` on `PATH`, and otherwise downloads the artifact pinned by `opencodeV2Version` in the repository `constants.json` and checks it against `apps/server/src/opencode-v2-artifacts.json` before running it.

The Daytona snapshot (`Dockerfile.daytona-snapshot`) bakes that same pinned, integrity-checked binary at `/usr/local/bin/opencode2` and sets `OPENWORK_OPENCODE2_BIN`, so cloud workers never download an engine at boot.
