#!/usr/bin/env bun
// Self-check for Agents-panel grouping tokens. Run: bun test-space-headers.js
import assert from "node:assert";
import {
  badgeStatus,
  kindGlyph,
  kindKey,
  statusGlyph,
  spaceHeaderWanted,
} from "./sync-labels.js";

assert.equal(kindGlyph("claude"), "✳");
assert.equal(kindGlyph("codex"), "●");
assert.equal(kindGlyph("grok"), "Ø");
assert.equal(kindKey("claude"), "claude");
assert.equal(kindKey("cursor"), "other");
assert.equal(statusGlyph("blocked"), "?");
assert.equal(statusGlyph("working"), ":");
assert.equal(statusGlyph("done"), "✓");
assert.equal(statusGlyph("idle"), "○");
assert.equal(badgeStatus({ agent_status: "blocked" }), "blocked");
assert.equal(badgeStatus({ agent_status: "idle", seen: false }), "done");
assert.equal(badgeStatus({ agent_status: "idle", seen: true }), "idle");

const first = spaceHeaderWanted({
  label: "MSFT",
  index: 0,
  groupSize: 2,
  lastGroup: false,
  agent: "grok",
  agent_status: "idle",
  seen: true,
});
assert.equal(first.space_header, "MSFT");
assert.equal(first.kind_grok, "Ø");
assert.equal(first.stat_idle, "○");
assert.equal(first.kind_claude, "");
assert.equal(first.stat_blocked, "");
assert.equal(first.group_gap, "");
assert.equal(first.badge_idle, "");

const last = spaceHeaderWanted({
  label: "MSFT",
  index: 1,
  groupSize: 2,
  lastGroup: false,
  agent: "grok",
  agent_status: "idle",
  seen: true,
});
assert.equal(last.space_header, "");
assert.ok(last.kind_grok.endsWith("Ø"));
assert.notEqual(last.kind_grok, first.kind_grok);
assert.equal(last.stat_idle, "○");
assert.equal(last.group_gap, "\u2800");

const blocked = spaceHeaderWanted({
  label: "Vault Keeper",
  index: 0,
  groupSize: 3,
  lastGroup: true,
  agent: "claude",
  agent_status: "blocked",
});
assert.equal(blocked.space_header, "Vault Keeper");
assert.equal(blocked.kind_claude, "✳");
assert.equal(blocked.stat_blocked, "?");
assert.equal(blocked.group_gap, "");

console.log("ok");
