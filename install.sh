#!/usr/bin/env bash
#
# Install the `ai` CLI into ~/.local/bin (override with PREFIX=/some/path).
#
# Builds the ai-cli package with Bun, installs the bundle + its wasm asset into
# $PREFIX/share/ai-cli, and drops an `ai` launcher into $PREFIX/bin.
#
# Usage:
#   ./install.sh                 # install to ~/.local
#   PREFIX=/usr/local ./install.sh
#   ./install.sh --no-build      # skip the build, install existing dist/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$SCRIPT_DIR/packages/ai-cli"

PREFIX="${PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"
LIB_DIR="$PREFIX/share/ai-cli"
DIST_DIR="$PKG_DIR/dist"

BUILD=1
[ "${1:-}" = "--no-build" ] && BUILD=0

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
err() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || err "node is required on PATH to run the CLI"

if [ "$BUILD" -eq 1 ]; then
  command -v bun >/dev/null 2>&1 || err "bun is required to build (or pass --no-build to use an existing dist/)"
  log "Building ai-cli…"
  ( cd "$PKG_DIR" && bun install && bun run build )
fi

[ -f "$DIST_DIR/index.js" ] || err "no build output at $DIST_DIR/index.js (run without --no-build)"

log "Installing bundle to $LIB_DIR"
mkdir -p "$LIB_DIR"
# Clear stale assets (e.g. old hashed wasm files) before copying the fresh build.
rm -f "$LIB_DIR"/*.js "$LIB_DIR"/*.wasm
cp "$DIST_DIR"/* "$LIB_DIR"/

log "Installing launcher to $BIN_DIR/ai"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/ai" <<EOF
#!/usr/bin/env bash
exec node "$LIB_DIR/index.js" "\$@"
EOF
chmod +x "$BIN_DIR/ai"

log "Installed: $("$BIN_DIR/ai" --version 2>/dev/null || echo 'ai') at $BIN_DIR/ai"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '\033[1;33mNote:\033[0m %s is not on your PATH. Add it, e.g.:\n  export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR" ;;
esac
