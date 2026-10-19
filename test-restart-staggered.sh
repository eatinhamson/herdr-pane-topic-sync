#!/usr/bin/env bash
# Checks scripts/restart-panes-staggered.sh against a fixture agent list, never
# against a live Herdr. Failure modes: all panes restarted in one burst (the
# 2026-10-14 and 10-15 MCP connect timeouts), non-Claude panes restarted, a
# dry run that executes the restart command, no pause between groups.
set -euo pipefail
cd "$(dirname "$0")"
T="$(mktemp -d)"; trap 'mv "$T" "${TMPDIR:-/tmp}/restart-test-done-$$" 2>/dev/null || true' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

jq -n '{result:{agents:([range(0;12)|{agent:"claude",pane_id:("w1:p\(.)")}] + [{agent:"grok",pane_id:"w1:g1"},{agent:"claude",pane_id:null}])}}' > "$T/agents.json"

# Dry run: prints three groups of at most five, runs nothing.
out="$(scripts/restart-panes-staggered.sh --agents-json "$T/agents.json" --cmd "touch $T/ran-{pane}" --pause 0)"
[[ "$(grep -c '^group ' <<<"$out")" == 3 ]] || fail "expected 3 groups, got: $out"
grep -q 'group 3/3: w1:p10 w1:p11$' <<<"$out" || fail "last group wrong: $out"
grep -q grok <<<"$out" && fail "non-Claude pane listed"
ls "$T"/ran-* >/dev/null 2>&1 && fail "dry run executed the restart command"

# --run: every Claude pane restarted once, group by group, pause between groups only.
scripts/restart-panes-staggered.sh --agents-json "$T/agents.json" --cmd "echo {pane} >> $T/log" --pause 1 --run >"$T/run.out"
[[ "$(wc -l < "$T/log" | tr -d ' ')" == 12 ]] || fail "expected 12 restarts"
[[ "$(grep -c '^pause ' "$T/run.out")" == 2 ]] || fail "expected 2 pauses for 3 groups"

# --group-size is honoured.
out="$(scripts/restart-panes-staggered.sh --agents-json "$T/agents.json" --cmd true --pause 0 --group-size 4)"
[[ "$(grep -c '^group ' <<<"$out")" == 3 ]] || fail "group-size 4 over 12 panes should give 3 groups"
echo "ok"
