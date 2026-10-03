#!/usr/bin/env bash
# Build a flush-patched Herdr and install it as ~/.local/bin/herdr-flush-agents:
#   - flush Agents-panel rows (no renderer-owned indent)
#   - single-space separators instead of " · " between sidebar tokens
#
# This is the supported way to update Herdr. `herdr update`, `brew upgrade herdr`
# and `brew link --overwrite herdr` all install stock and drop the patch.
#
# Usage: ./scripts/install-flush-herdr.sh [options] [VERSION]
#   VERSION     Herdr release without the "v" (default: latest stable on GitHub)
#   --check     fetch the tag, pick a patch, prove it applies; build nothing
#   --link      also point $HERDR_LINK (/opt/homebrew/bin/herdr) at the new build
#   --handoff   also run `herdr server live-handoff` (needs --link). Panes are kept,
#               but your client detaches: re-run `herdr` to reattach.
# Env: HERDR_SRC       git checkout used as the object store (default ~/Development/herdr)
#      HERDR_WORKTREE  build tree (default <HERDR_SRC>-<VERSION>)
#      HERDR_FLUSH_PREFIX, HERDR_LINK
# HERDR_SRC's working tree is never modified: builds happen in a separate git worktree.
# Needs git, curl, jq, cargo, and the Zig that upstream's build.rs asks for
# (0.9.x wants Zig 0.16: `brew install zig`; set ZIG=/path/to/zig to override).

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:/usr/bin:/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${HERDR_SRC:-$HOME/Development/herdr}"
PREFIX="${HERDR_FLUSH_PREFIX:-$HOME/.local}"
BIN="$PREFIX/bin/herdr-flush-agents"
LINK="${HERDR_LINK:-/opt/homebrew/bin/herdr}"

die() { echo "error: $*" >&2; exit 1; }

CHECK=0 LINKIT=0 HANDOFF=0 VER=""
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --link) LINKIT=1 ;;
    --handoff) HANDOFF=1 ;;
    -h|--help) sed -n '2,/^$/p' "$0"; exit 0 ;;
    -*) die "unknown option: $arg (see --help)" ;;
    *) VER="${arg#v}" ;;
  esac
done
if (( HANDOFF && ! LINKIT )); then die "--handoff needs --link (the new server starts from the herdr at $LINK)"; fi

for tool in git curl jq; do command -v "$tool" >/dev/null || die "$tool not found"; done
if (( ! CHECK )); then
  command -v cargo >/dev/null || die "cargo not found"
  command -v zig >/dev/null || [[ -n "${ZIG:-}" ]] || die "zig not found (brew install zig, or set ZIG=/path/to/zig)"
fi

if [[ -z "$VER" ]]; then
  VER=$(curl -fsS -m 20 -H 'Accept: application/vnd.github+json' \
    https://api.github.com/repos/herdrdev/herdr/releases/latest | jq -r '.tag_name | ltrimstr("v")') \
    || die "could not look up the latest stable release; pass VERSION explicitly"
fi
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "unexpected version '$VER'"

# HERDR_SRC is only an object store; it is fetched but its working tree is never touched.
if [[ ! -d "$SRC/.git" ]]; then
  echo "cloning herdrdev/herdr into $SRC (object store for build worktrees)"
  mkdir -p "$(dirname "$SRC")"
  git clone https://github.com/herdrdev/herdr.git "$SRC"
fi
git -C "$SRC" fetch --tags origin >/dev/null 2>&1 || echo "warning: fetch failed; using local tags"
git -C "$SRC" rev-parse -q --verify "refs/tags/v$VER" >/dev/null || die "tag v$VER not found upstream"

WT="${HERDR_WORKTREE:-$(dirname "$SRC")/herdr-$VER}"
if git -C "$SRC" worktree list --porcelain | grep -qxF "worktree $WT"; then
  git -C "$WT" checkout -q -f --detach "v$VER"   # script-owned tree: drop any previous patch
elif [[ -e "$WT" ]]; then
  die "$WT exists but is not a worktree of $SRC; set HERDR_WORKTREE"
else
  git -C "$SRC" worktree add -q --detach "$WT" "v$VER"
fi

# Newest patch first; fall back to older ones until one applies cleanly.
patches=("$ROOT"/patches/herdr-*-flush-agent-rows.patch)
PATCH=""
for ((i = ${#patches[@]} - 1; i >= 0; i--)); do
  if git -C "$WT" apply --check "${patches[i]}" 2>/dev/null; then PATCH="${patches[i]}"; break; fi
done
[[ -n "$PATCH" ]] || die "no patch in patches/ applies to v$VER: port the newest one by hand and save it as patches/herdr-<ver>-flush-agent-rows.patch"
echo "v$VER: using $(basename "$PATCH")"

if (( CHECK )); then echo "check ok: patch applies; nothing built or installed"; exit 0; fi
git -C "$WT" apply "$PATCH"

echo "building v$VER in $WT"
( cd "$WT" && cargo build --release )
NEW="$WT/target/release/herdr"
[[ "$("$NEW" --version)" == *"$VER"* ]] || die "built binary does not report $VER"

mkdir -p "$PREFIX/bin"
if [[ -x "$BIN" ]]; then   # keep the previous build as a fallback: herdr-flush-agents.<ver>
  old=$("$BIN" --version 2>/dev/null | awk '{print $2}' || true)
  if [[ -n "$old" && "$old" != "$VER" ]]; then cp -n "$BIN" "$BIN.$old" || true; fi
fi
cp -f "$NEW" "$BIN.new"
chmod +x "$BIN.new"
mv -f "$BIN.new" "$BIN"
echo "installed $BIN ($("$BIN" --version))"

if (( LINKIT )); then
  ln -sfn "$BIN" "$LINK"
  echo "linked $LINK -> $BIN"
else
  echo "next: ln -sfn $BIN $LINK"
fi

if (( HANDOFF )); then
  echo "handing the running server to $VER (panes are kept; your client will detach)"
  "$LINK" server live-handoff --expected-version "$VER"
  echo "re-run \`herdr\` in your terminal to reattach"
else
  echo "next: herdr server live-handoff --expected-version $VER   (then re-run herdr)"
fi
echo "verify: $ROOT/healthcheck.sh"
