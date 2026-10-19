#!/usr/bin/env bash
# Restart Herdr's Claude panes in groups, with a pause between groups.
#
#   restart-panes-staggered.sh --cmd 'COMMAND WITH {pane}' [--group-size 5] [--pause 45]
#                              [--agents-json FILE] [--run]
#
# Why: a Herdr update restarted about 25 panes at once on 2026-10-14 and 10-15.
# The panes started their MCP servers together, connect time passed the 30 s
# budget, and 55 process starts lost the vault, Jira and rea servers for the
# rest of their process (T-7 audit 2026-10-16, F6). Five at a time keeps each
# connect near its 2.4 s median.
#
# Default is a dry run: it prints the groups and runs nothing. --run executes
# --cmd once per pane, with {pane} replaced by the pane id, and sleeps --pause
# seconds between groups. --agents-json reads a saved `herdr agent list`
# instead of the live server (used by test-restart-staggered.sh).
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:/usr/bin:/bin:$PATH"

SIZE=5 PAUSE=45 CMD="" JSON="" RUN=0
while (( $# )); do
  case "$1" in
    --cmd) CMD="$2"; shift ;;
    --group-size) SIZE="$2"; shift ;;
    --pause) PAUSE="$2"; shift ;;
    --agents-json) JSON="$2"; shift ;;
    --run) RUN=1 ;;
    -h|--help) sed -n '2,/^set /p' "$0" | sed '$d'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -n "$CMD" ]] || { echo "--cmd is required" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 1; }

if [[ -n "$JSON" ]]; then agents="$(cat "$JSON")"; else agents="$(herdr agent list)"; fi
# Only Claude panes load MCP servers; other agents are left alone.
panes=()
while IFS= read -r pane; do panes+=("$pane"); done \
  < <(jq -r '.result.agents[] | select(.agent=="claude" and .pane_id != null) | .pane_id' <<<"$agents")

total=${#panes[@]}
(( total )) || { echo "no Claude panes"; exit 0; }
groups=$(( (total + SIZE - 1) / SIZE ))
for (( g = 0; g < groups; g++ )); do
  batch=("${panes[@]:$(( g * SIZE )):$SIZE}")
  echo "group $(( g + 1 ))/$groups: ${batch[*]}"
  if (( RUN )); then
    for pane in "${batch[@]}"; do bash -c "${CMD//\{pane\}/$pane}"; done
    if (( g + 1 < groups )); then echo "pause ${PAUSE}s"; sleep "$PAUSE"; fi
  fi
done
