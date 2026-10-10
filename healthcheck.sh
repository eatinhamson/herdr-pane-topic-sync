#!/usr/bin/env bash
# Fleet health check (agent-ops runs it daily). Fails when a Herdr or plugin
# update would silently stop the closed-tab recorder that herdr-resume reads,
# or silently swap the flush-patched Herdr for stock:
#   0. `herdr` on PATH is no longer the flush-patched build (`herdr update` or
#      `brew upgrade|link --overwrite herdr` installs stock: indented agent rows,
#      " · " separators)
#   1. plugin no longer linked + enabled from this checkout
#   2. recorder self-tests fail
#   3. Herdr's pane/tab lists no longer carry the fields the recorder diffs
#   4. every recent plugin run failed (e.g. bun missing after an upgrade)
# Warns (still exits 0) when the running server is older than the binary on
# disk: the rebuilt binary is installed but `herdr server live-handoff` is pending.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:/usr/bin:/bin"
ROOT="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ID="dan.pane-topic-sync"
FLUSH_BIN="${HERDR_FLUSH_BIN:-$HOME/.local/bin/herdr-flush-agents}"
fail() { echo "FAIL: $*"; exit 1; }

command -v bun >/dev/null || fail "bun not on PATH"
(cd "$ROOT" && bun test-decide.js >/dev/null 2>&1) || fail "bun test-decide.js failed"

# `herdr` must resolve to the flush-patched build (scripts/install-flush-herdr.sh).
herdr_bin=$(command -v herdr) || fail "herdr not on PATH"
[[ -x "$FLUSH_BIN" ]] \
  || fail "flush-patched Herdr missing at $FLUSH_BIN — rebuild it (README: flush patch)"
[[ "$(realpath "$herdr_bin")" == "$(realpath "$FLUSH_BIN")" ]] \
  || fail "herdr resolves to $(realpath "$herdr_bin"), not the flush-patched $FLUSH_BIN (stock build: indented rows, ' · ' separators) — relink it, then run: herdr server live-handoff"

if ! plugins=$(herdr plugin list --json 2>/dev/null); then
  echo "ok: self-tests pass; flush-patched herdr in place; herdr not running, live checks skipped"
  exit 0
fi

root=$(jq -r --arg id "$PLUGIN_ID" '.result.plugins[] | select(.plugin_id==$id and .enabled) | .plugin_root' <<<"$plugins")
[[ -n "$root" ]] || fail "$PLUGIN_ID not installed or disabled — run: herdr plugin link \"$ROOT\""
[[ "$(cd "$root" 2>/dev/null && pwd -P)" == "$(cd "$ROOT" && pwd -P)" ]] \
  || fail "$PLUGIN_ID loads from $root, not $ROOT"

panes=$(herdr pane list 2>/dev/null) || fail "herdr pane list failed"
tabs=$(herdr tab list 2>/dev/null) || fail "herdr tab list failed"
jq -e '.result.tabs | type == "array" and all(.[]; (.tab_id | type) == "string")' <<<"$tabs" >/dev/null \
  || fail "herdr tab list no longer returns .result.tabs[].tab_id"
# pi panes carry no agent_session (herdr does not report one); every other agent must.
# A pane parked by herdr-lifecycle reports agent "parked": its agent is stopped, so it has none.
jq -e '.result.panes | type == "array"
       and all(.[] | select(.agent); (.tab_id | type) == "string"
               and (.agent == "pi" or .agent == "parked" or (.agent_session.value | type) == "string"))' \
  <<<"$panes" >/dev/null \
  || fail "herdr pane list agent panes lack tab_id or agent_session.value"

logs=$(herdr plugin log list --plugin "$PLUGIN_ID" --limit 20 2>/dev/null) || logs='{"result":{"logs":[]}}'
read -r total ok < <(jq -r '[.result.logs | length, (map(select(.status=="succeeded")) | length)] | @tsv' <<<"$logs")
if (( total >= 5 && ok == 0 )); then
  fail "last $total plugin runs all failed: $(jq -r '.result.logs[0].stderr // "" | .[0:160]' <<<"$logs")"
fi

stale=""
if herdr status 2>/dev/null | grep -q 'server_binary_stale: yes'; then
  stale="; WARN: running server is older than the binary on disk (run: herdr server live-handoff)"
fi

agents=$(jq '[.result.panes[] | select(.agent)] | length' <<<"$panes")
echo "ok: linked from $ROOT; flush-patched herdr in place; self-tests pass; $agents agent panes carry tab_id + session id; $ok/$total recent runs succeeded$stale"
