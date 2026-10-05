#!/usr/bin/env bun
// Self-check for decide()'s pin/refresh logic. Run: bun test-decide.js
import assert from "node:assert";
import { decide, carryForward, remember } from "./sync-labels.js";

// Fresh id, nothing there yet -> safe to write the auto label.
assert.deepStrictEqual(decide(undefined, undefined, "wanted"), { label: "wanted", pinned: false, write: true });

// Fresh id, but something already has a label we've never written -> adopt
// it as a pinned baseline instead of clobbering unknown provenance.
assert.deepStrictEqual(decide(undefined, "pre-existing", "wanted"), { label: "pre-existing", pinned: true, write: false });

// Untouched, topic changed -> auto-refresh.
assert.deepStrictEqual(
  decide({ label: "old-topic", pinned: false }, "old-topic", "new-topic"),
  { label: "new-topic", pinned: false, write: true },
);

// Untouched, topic unchanged -> no-op.
assert.deepStrictEqual(
  decide({ label: "same", pinned: false }, "same", "same"),
  { label: "same", pinned: false, write: false },
);

// Renamed by hand -> pins, does not write.
assert.deepStrictEqual(
  decide({ label: "old-topic", pinned: false }, "My Custom Name", "new-topic"),
  { label: "My Custom Name", pinned: true, write: false },
);

// Pinned, topic drifts further on later ticks -> stays pinned (this is the
// bug the first cut of this logic had: comparing against `wanted` every
// tick reverted the pin on the very next sync since a hand-typed name
// almost never matches the live topic).
assert.deepStrictEqual(
  decide({ label: "My Custom Name", pinned: true }, "My Custom Name", "yet-another-topic"),
  { label: "My Custom Name", pinned: true, write: false },
);

// Pinned, human retypes it to exactly the current auto label -> unpins.
assert.deepStrictEqual(
  decide({ label: "My Custom Name", pinned: true }, "current-topic", "current-topic"),
  { label: "current-topic", pinned: false, write: false },
);

// Pinned, human renames it again to something else -> stays pinned, new value.
assert.deepStrictEqual(
  decide({ label: "My Custom Name", pinned: true }, "Another Name", "current-topic"),
  { label: "Another Name", pinned: true, write: false },
);

// Old (pre-pin-tracking) state file stored a bare string -> migrates as unpinned.
assert.deepStrictEqual(decide("old-topic", "old-topic", "new-topic"), { label: "new-topic", pinned: false, write: true });

// Label history (ported from upstream v0.3.0): a live label we wrote earlier
// is still ours. A slower concurrent run can persist a stale `label`, and
// that must not read as a hand rename.
assert.deepStrictEqual(
  decide({ label: "B", pinned: false, seen: ["B", "A"] }, "A", "C"),
  { label: "C", pinned: false, write: true },
);
assert.deepStrictEqual(
  decide({ label: "B", pinned: false, seen: ["B", "A"] }, "A", "A"),
  { label: "A", pinned: false, write: false },
);
// A name outside the history is still a hand rename.
assert.deepStrictEqual(
  decide({ label: "B", pinned: false, seen: ["B", "A"] }, "Mine", "C"),
  { label: "Mine", pinned: true, write: false },
);
// Self-heal: no prior entry, but the live label is exactly what we would write.
assert.deepStrictEqual(decide(undefined, "wanted", "wanted"), { label: "wanted", pinned: false, write: false });

// carryForward keeps entries for ids still alive (a pane that stopped being an
// agent pane for a run keeps its history); closed ids are pruned.
assert.deepStrictEqual(
  carryForward({ p1: { label: "a", pinned: false }, p2: { label: "b", pinned: true } }, new Set(["p1"])),
  { p1: { label: "a", pinned: false } },
);
assert.deepStrictEqual(remember({ label: "B", pinned: false, seen: ["B", "A"] }, "C"), ["C", "B", "A"]);
assert.deepStrictEqual(remember({ label: "B", pinned: false, seen: ["B", "A"] }, "A"), ["A", "B"]);
assert.strictEqual(remember(undefined, "x").length, 1);
assert.strictEqual(remember({ seen: ["1", "2", "3", "4", "5"] }, "6").length, 5);

console.log("decide(): all cases pass");

// Generic topics
import { isGenericTopic, isDefaultTabLabel, isDefaultPaneLabel } from "./sync-labels.js";

assert.strictEqual(isGenericTopic("", "claude"), true);
assert.strictEqual(isGenericTopic("claude", "claude"), true);
assert.strictEqual(isGenericTopic("Claude Code", "claude"), true);
assert.strictEqual(isGenericTopic("claude-code", "claude"), true);
assert.strictEqual(isGenericTopic("claude-build", "claude"), true);
assert.strictEqual(isGenericTopic("claude-kong", "claude"), true);
assert.strictEqual(isGenericTopic("Antigravity", "agy"), true);
assert.strictEqual(isGenericTopic("antigravity", "agy"), true);
assert.strictEqual(isGenericTopic("agy", "agy"), true);
assert.strictEqual(isGenericTopic("codex", "codex"), true);
assert.strictEqual(isGenericTopic("codex-kong", "codex"), true);
assert.strictEqual(isGenericTopic("grok", "grok"), true);
assert.strictEqual(isGenericTopic("new tab", "claude"), true);
assert.strictEqual(isGenericTopic("UDX MCI/MCO issues RACI update", "claude"), false);
assert.strictEqual(isGenericTopic("Weekly activity review", "claude"), false);
console.log("isGenericTopic(): all cases pass");

// Default tab labels
assert.strictEqual(isDefaultTabLabel("6", "claude", 6), true);
assert.strictEqual(isDefaultTabLabel("7", "agy", 7), true);
assert.strictEqual(isDefaultTabLabel("356", "claude", 1), true); // Any numeric tab label is a default
assert.strictEqual(isDefaultTabLabel("Claude Code", "claude", 1), true);
assert.strictEqual(isDefaultTabLabel("Antigravity", "agy", 1), true);
assert.strictEqual(isDefaultTabLabel("agy", "agy", 1), true);
assert.strictEqual(isDefaultTabLabel("claude", "claude", 1), true);
assert.strictEqual(isDefaultTabLabel("codex", "codex", 1), true);
assert.strictEqual(isDefaultTabLabel("grok", "grok", 1), true);
assert.strictEqual(isDefaultTabLabel("MRT", "claude", 1), false);
assert.strictEqual(isDefaultTabLabel("WYNND", "codex", 1), false);
assert.strictEqual(isDefaultTabLabel("My Custom Tab", "agy", 1), false);
console.log("isDefaultTabLabel(): all cases pass");

// Default pane labels
assert.strictEqual(isDefaultPaneLabel({ label: "Claude Code", agent: "claude" }, "Vault Keeper"), true);
assert.strictEqual(isDefaultPaneLabel({ label: "Antigravity", agent: "agy" }, "Vault Keeper"), true);
assert.strictEqual(isDefaultPaneLabel({ label: "Vault Keeper", agent: "codex" }, "Vault Keeper"), true);
assert.strictEqual(
  isDefaultPaneLabel(
    { label: "/Users/ethanhansen/Vault Keep…", agent: "codex", cwd: "/Users/ethanhansen/Vault Keeper" },
    "Vault Keeper",
  ),
  true,
);
assert.strictEqual(isDefaultPaneLabel({ label: "Custom Task", agent: "claude" }, "Vault Keeper"), false);
console.log("isDefaultPaneLabel(): all cases pass");

// Closed-tab recorder. Herdr does not emit tab.closed when a tab's last pane
// closes, so closures are found by diffing the saved snapshot against the
// live tab list on every run.
import { closedTabRecords, loadState, mergeTabSessions, saveState } from "./sync-labels.js";

const pane = (tab, agent, sid, title = sid) =>
  ({ tab_id: tab, agent, agent_session: { value: sid }, cwd: `/${sid}`, label: title });
const closedAt = new Date("2026-09-28T12:00:00Z");

// The snapshot survives a state save/load round trip.
saveState({ panes: {}, tabs: {}, tab_sessions: { "w1:t1": [{ agent: "codex", sid: "a" }] } });
assert.deepStrictEqual(loadState().tab_sessions, { "w1:t1": [{ agent: "codex", sid: "a" }] });

// Sessions accumulate per live tab (an agent that exits before its tab closes
// is kept), shell panes are ignored, and closed tabs drop out of the snapshot.
let snap = mergeTabSessions({}, [pane("w1:t1", "codex", "a"), pane("w1:t2", "", "")], ["w1:t1", "w1:t2"]);
assert.deepStrictEqual(Object.keys(snap), ["w1:t1"]);
snap = mergeTabSessions(snap, [pane("w1:t1", "claude", "b")], ["w1:t1"]);
assert.deepStrictEqual(snap["w1:t1"].map((s) => s.sid), ["a", "b"]);
assert.deepStrictEqual(mergeTabSessions(snap, [], []), {});

// A tab missing from the live list is recorded with its sessions in order.
assert.deepStrictEqual(closedTabRecords(snap, [], [], closedAt), [{
  closed_at: "2026-09-28T12:00:00.000Z",
  workspace_id: "w1",
  tab_id: "w1:t1",
  sessions: snap["w1:t1"],
}]);
// Still-open tab: nothing recorded.
assert.deepStrictEqual(closedTabRecords(snap, ["w1:t1"], [], closedAt), []);
// Tab gone but its sessions are live elsewhere (moved pane, renumbered tab
// after a server restart): nothing recorded.
assert.deepStrictEqual(closedTabRecords(snap, [], [pane("w1:t9", "codex", "a"), pane("w1:t9", "claude", "b")], closedAt), []);
// Only the sessions that are no longer live are recorded.
assert.deepStrictEqual(closedTabRecords(snap, [], [pane("w1:t9", "codex", "a")], closedAt)[0].sessions.map((s) => s.sid), ["b"]);
console.log("closed-tab recorder: all cases pass");
