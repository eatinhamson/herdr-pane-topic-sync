#!/usr/bin/env bun
//
// Pane Topic Sync -- herdr plugin
//
// On each subscribed event, walk every pane in the session and:
//   1. rename each *agent* pane to its live topic (terminal_title_stripped)
//   2. rename each tab to the topic of a chosen pane (see `tab_source`)
//
// Plain (non-agent) shell panes are ignored so a tab never gets named after a
// shell prompt. Writes are gated through a state file so we only call
// `rename` when a label actually changed -- no churn, and (combined with not
// subscribing to *.renamed events) no feedback loop. The state file also
// tracks the last label WE wrote per pane/tab, so a hand-typed rename (live
// label != what we last wrote) is detected and left alone from then on,
// instead of being clobbered on the next topic change.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const herdr = process.env.HERDR_BIN_PATH || "herdr";
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || "/tmp";
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || "";
const statePath = join(stateDir, "pane-topic-sync-state.json");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULTS = {
  sync_panes: true,        // rename agent panes to their topic
  sync_tabs: true,         // rename tabs to a pane's topic
  tab_source: "first",     // "first" (top-left) | "active" (tab's focused pane)
  max_label_length: 60,    // truncate longer labels with an ellipsis (0 = no limit)
  max_pane_label_length: null, // pane-only override (0 = no limit; null = use max_label_length)
  max_tab_label_length: null,  // tab-only override (0 = no limit; null = use max_label_length)
  max_words: 0,            // keep only the first N words of a topic (0 = no limit)
  tab_format: "{topic}",   // tokens: {topic} {agent} {n} {workspace}
  pane_format: "{topic}",  // tokens: {topic} {agent} {workspace}
};

// Minimal flat-TOML reader: key = value, one per line. Values may be quoted
// strings (which may themselves contain '#', '{', etc.), bare booleans, or
// integers. Sufficient for this plugin's flat config; not a general parser.
function parseFlatToml(text) {
  const out = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    out[key] = parseValue(line.slice(eq + 1).trim());
  }
  return out;
}

function parseValue(raw) {
  if (raw[0] === '"' || raw[0] === "'") {
    const end = raw.indexOf(raw[0], 1);
    return end > 0 ? raw.slice(1, end) : raw.slice(1);
  }
  const bare = raw.replace(/\s+#.*$/, "").trim(); // strip trailing comment
  if (bare === "true") return true;
  if (bare === "false") return false;
  if (/^-?\d+$/.test(bare)) return parseInt(bare, 10);
  return bare;
}

function loadConfig() {
  const cfg = { ...DEFAULTS };
  if (configDir) {
    try {
      Object.assign(cfg, parseFlatToml(readFileSync(join(configDir, "config.toml"), "utf8")));
    } catch {
      // no config file -> defaults
    }
  }
  // Validate / coerce.
  cfg.sync_panes = cfg.sync_panes !== false;
  cfg.sync_tabs = cfg.sync_tabs !== false;
  if (cfg.tab_source !== "active") cfg.tab_source = "first";
  const n = parseInt(cfg.max_label_length, 10);
  cfg.max_label_length = Number.isFinite(n) && n >= 0 ? n : DEFAULTS.max_label_length;
  // Per-surface caps fall back to max_label_length when unset.
  for (const key of ["max_pane_label_length", "max_tab_label_length"]) {
    const v = parseInt(cfg[key], 10);
    cfg[key] = Number.isFinite(v) && v >= 0 ? v : cfg.max_label_length;
  }
  const mw = parseInt(cfg.max_words, 10);
  cfg.max_words = Number.isFinite(mw) && mw > 0 ? mw : 0;
  if (typeof cfg.tab_format !== "string" || !cfg.tab_format) cfg.tab_format = DEFAULTS.tab_format;
  if (typeof cfg.pane_format !== "string" || !cfg.pane_format) cfg.pane_format = DEFAULTS.pane_format;
  return cfg;
}

// ---------------------------------------------------------------------------
// herdr CLI helpers
// ---------------------------------------------------------------------------

function run(args) {
  const r = spawnSync(herdr, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    throw new Error(`${herdr} ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return r.stdout.trim();
}

function json(args) {
  const out = run(args);
  return out ? JSON.parse(out) : null;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

// Normalize a raw topic: drop control chars / spinner / stray markup, collapse
// whitespace. Does NOT truncate -- truncation happens after formatting.
function normalize(value) {
  return String(value ?? "")
    .replace(/[\x00-\x1f\x7f]/g, " ")               // control chars
    .replace(/^<command-name>.*?<\/command-name>\s*/i, "")
    .replace(/<[^>]+>/g, " ")                        // stray markup
    .replace(/^[>›⠀-⣿]+\s*/, "")       // leading '>', '›', braille spinner
    .replace(/\s+/g, " ")
    .trim();
}

// Truncate to `max` chars with an ellipsis (0 = no limit).
function cap(str, max) {
  if (!max || str.length <= max) return str;
  return `${str.slice(0, max - 1).trimEnd()}…`;
}

// Keep only the first `n` words of a topic (0 = no limit).
function limitWords(str, n) {
  if (!n) return str;
  const w = str.split(" ");
  return w.length <= n ? str : `${w.slice(0, n).join(" ")}…`;
}

// "grok" / "claude" is the agent name, not a topic. Grok's OSC title stays
// at that name even after it writes generated_title to summary.json.
function isGenericTopic(topic, agent) {
  const t = String(topic || "").trim().toLowerCase();
  if (!t) return true;
  const a = String(agent || "").trim().toLowerCase();
  return t === a || t === `${a}-build`;
}

function grokSessionTitle(pane) {
  const sid = pane.agent_session?.value;
  if (!sid || typeof sid !== "string") return "";
  const root = join(process.env.GROK_HOME || join(homedir(), ".grok"), "sessions");
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, sid, "summary.json");
    if (!existsSync(path)) continue;
    try {
      const summary = JSON.parse(readFileSync(path, "utf8"));
      return String(summary.generated_title || summary.session_summary || "")
        .replace(/\s+-\s+grok$/i, "")
        .trim();
    } catch {
      return "";
    }
  }
  return "";
}

function topicFor(pane, cfg) {
  let topic = limitWords(normalize(pane.terminal_title_stripped), cfg.max_words);
  if (isGenericTopic(topic, pane.agent) && String(pane.agent).toLowerCase() === "grok") {
    topic = limitWords(normalize(grokSessionTitle(pane)), cfg.max_words);
  }
  return isGenericTopic(topic, pane.agent) ? "" : topic;
}

// Replace {token}s from `tokens`; unknown tokens are left literal.
function applyFormat(fmt, tokens) {
  return fmt.replace(/\{(\w+)\}/g, (m, k) => (k in tokens ? String(tokens[k] ?? "") : m));
}

// ---------------------------------------------------------------------------
// State -- tracks, per pane/tab, the label WE last wrote and whether it's
// currently pinned (a human renamed it out from under us). Old state files
// stored a bare string (no pin tracking); normalizeEntry migrates those in
// place as "not pinned".
// ---------------------------------------------------------------------------

function normalizeEntry(v) {
  if (v === undefined) return undefined;
  return typeof v === "string" ? { label: v, pinned: false } : v;
}

function loadState() {
  try {
    const s = JSON.parse(readFileSync(statePath, "utf8"));
    return { panes: s.panes || {}, tabs: s.tabs || {} };
  } catch {
    return { panes: {}, tabs: {} };
  }
}

function saveState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

// Decide whether to (re)write a label, given the state entry we last saved
// (undefined if never seen), the live label right now, and what we'd
// compute now. Returns { label, pinned, write }, the new state entry plus
// whether a rename call is needed.
//
// A pin sticks until the human touches the label again AND retypes it back
// to exactly what we'd currently auto-set -- that's treated as "put it back
// on auto" (see README). Otherwise `wanted` almost always differs from a
// hand-typed name, so comparing against `wanted` every tick would revert
// the pin on the very next sync -- comparing against the pinned label
// itself is what makes the pin durable.
export function decide(prevEntry, live, wanted) {
  const prev = normalizeEntry(prevEntry);

  if (prev === undefined) {
    if (!live) return { label: wanted, pinned: false, write: true };
    return { label: live, pinned: true, write: false }; // unknown provenance -> don't clobber
  }

  if (prev.pinned) {
    if (live === prev.label) return { label: prev.label, pinned: true, write: false };
    if (live === wanted) return { label: wanted, pinned: false, write: false }; // retyped to match auto -> unpin
    return { label: live, pinned: true, write: false }; // renamed again -> stay pinned, new value
  }

  if (live !== prev.label) return { label: live, pinned: true, write: false }; // renamed by hand -> pin
  if (wanted !== live) return { label: wanted, pinned: false, write: true };
  return { label: prev.label, pinned: false, write: false };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const cfg = loadConfig();
  const panes = json(["pane", "list"])?.result?.panes ?? [];
  const tabs = json(["tab", "list"])?.result?.tabs ?? [];

  // paneId -> { topic, agent } for agent panes that have a real topic.
  const info = new Map();
  for (const p of panes) {
    if (!p.agent) continue;
    const topic = topicFor(p, cfg);
    if (topic) info.set(p.pane_id, { topic, agent: p.agent });
  }

  // Group panes by tab (list order).
  const byTab = new Map();
  for (const p of panes) {
    if (!byTab.has(p.tab_id)) byTab.set(p.tab_id, []);
    byTab.get(p.tab_id).push(p);
  }

  // Lazy workspace-label lookup (only if a format references {workspace}).
  const needWs = /\{workspace\}/.test(cfg.tab_format) || /\{workspace\}/.test(cfg.pane_format);
  const wsCache = new Map();
  const wsLabel = (id) => {
    if (!needWs || !id) return "";
    if (!wsCache.has(id)) {
      let label = "";
      try { label = normalize(json(["workspace", "get", id])?.result?.workspace?.label); } catch {}
      wsCache.set(id, label);
    }
    return wsCache.get(id);
  };

  let paneWrites = 0;
  let tabWrites = 0;
  const state = loadState();
  const nextPanes = {};

  // 1) Panes.
  if (cfg.sync_panes) {
    for (const p of panes) {
      const meta = info.get(p.pane_id);
      if (!meta) continue;
      const wanted = cap(
        applyFormat(cfg.pane_format, { topic: meta.topic, agent: meta.agent, workspace: wsLabel(p.workspace_id) }),
        cfg.max_pane_label_length,
      );
      const { label, pinned, write } = decide(state.panes[p.pane_id], p.label, wanted);
      nextPanes[p.pane_id] = { label, pinned };
      if (write) {
        run(["pane", "rename", p.pane_id, label]);
        paneWrites++;
      }
    }
  } else {
    // Preserve prior state so toggling sync_panes back on doesn't re-churn.
    Object.assign(nextPanes, state.panes);
  }

  // 2) Tabs. Tab switch number = 1-based position within its workspace.
  const orderInWs = new Map();
  const wsCounters = new Map();
  for (const t of tabs) {
    const c = (wsCounters.get(t.workspace_id) || 0) + 1;
    wsCounters.set(t.workspace_id, c);
    orderInWs.set(t.tab_id, c);
  }

  const nextTabs = {};
  if (cfg.sync_tabs) {
    const tabLabel = new Map(tabs.map((t) => [t.tab_id, t.label]));
    for (const [tabId, tabPanes] of byTab) {
      const srcId = sourcePaneId(tabPanes, cfg.tab_source);
      // Chosen pane's topic; fall back to first agent pane in list order.
      let meta = info.get(srcId);
      if (!meta) {
        for (const p of tabPanes) {
          if (info.has(p.pane_id)) { meta = info.get(p.pane_id); break; }
        }
      }
      if (!meta) continue;
      const wsId = tabPanes[0].workspace_id;
      const wanted = cap(
        applyFormat(cfg.tab_format, {
          topic: meta.topic,
          agent: meta.agent,
          n: orderInWs.get(tabId) ?? "",
          workspace: wsLabel(wsId),
        }),
        cfg.max_tab_label_length,
      );
      // herdr labels a fresh tab with its 1-based position ("5"); that is a
      // default, not a hand-typed name, so decide() must not pin it.
      const liveTab = tabLabel.get(tabId);
      const isDefault = liveTab === String(orderInWs.get(tabId));
      const { label, pinned, write } = decide(
        isDefault ? undefined : state.tabs[tabId],
        isDefault ? "" : liveTab,
        wanted,
      );
      nextTabs[tabId] = { label, pinned };
      if (write) {
        run(["tab", "rename", tabId, label]);
        tabWrites++;
      }
    }
  } else {
    Object.assign(nextTabs, state.tabs);
  }

  saveState({ panes: nextPanes, tabs: nextTabs });
  console.log(
    `synced: ${paneWrites} pane rename(s), ${tabWrites} tab rename(s) ` +
    `[panes=${cfg.sync_panes} tabs=${cfg.sync_tabs} source=${cfg.tab_source}]`,
  );
}

// Which pane's topic represents a tab, per config.
//   "active" -> the tab's own focused pane (herdr tracks this per tab)
//   "first"  -> top-left pane in reading order
function sourcePaneId(tabPanes, source) {
  if (tabPanes.length === 1) return tabPanes[0].pane_id;
  let layout;
  try { layout = json(["pane", "layout", "--pane", tabPanes[0].pane_id])?.result?.layout; } catch {}
  if (!layout?.panes?.length) return tabPanes[0].pane_id;
  if (source === "active" && layout.focused_pane_id) return layout.focused_pane_id;
  const sorted = [...layout.panes].sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));
  return sorted[0].pane_id;
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
