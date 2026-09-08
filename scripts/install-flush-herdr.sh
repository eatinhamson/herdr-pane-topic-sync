#!/usr/bin/env bash
# Build Herdr 0.8.2 with flush Agents-panel rows (no renderer-owned indent)
# and install to ~/.local/bin/herdr-flush-agents.
#
# Usage:
#   ./scripts/install-flush-herdr.sh
#   HERDR_SRC=~/src/herdr ./scripts/install-flush-herdr.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="$ROOT/patches/herdr-0.8.2-flush-agent-rows.patch"
SRC="${HERDR_SRC:-$HOME/Development/herdr}"
PREFIX="${HERDR_FLUSH_PREFIX:-$HOME/.local}"
BIN="$PREFIX/bin/herdr-flush-agents"

if [[ ! -f "$PATCH" ]]; then
  echo "missing patch: $PATCH" >&2
  exit 1
fi

if [[ ! -d "$SRC/.git" ]]; then
  echo "cloning herdr v0.8.2 into $SRC"
  mkdir -p "$(dirname "$SRC")"
  git clone --branch v0.8.2 --depth 1 https://github.com/herdrdev/herdr.git "$SRC"
fi

cd "$SRC"
git fetch --tags origin 2>/dev/null || true
git checkout -f v0.8.2
git apply --check "$PATCH"
git apply "$PATCH"

echo "building release (this needs Rust + zig@0.15 like upstream Herdr)"
cargo build --release

mkdir -p "$PREFIX/bin"
cp -f target/release/herdr "$BIN"
chmod +x "$BIN"
echo "installed $BIN"
echo "point your PATH herdr at it, e.g.:"
echo "  ln -sf $BIN /opt/homebrew/bin/herdr"
echo "or keep stock Homebrew herdr and run: $BIN"
