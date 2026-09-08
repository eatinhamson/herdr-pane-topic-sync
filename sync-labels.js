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
  sync_space_headers: true, // stamp Agents-panel $space_header / $badge_* / $group_gap
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
  cfg.sync_space_headers = cfg.sync_space_headers !== false;
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

// ---------------------------------------------------------------------------
// codex topics
//
// codex sets its terminal title to the cwd, so every codex pane in one repo
// reports the same generic name ("Vault Keeper"). Derive a real topic from the
// session id herdr already exposes: the rollout summary's filename slug once
// one has been written, else the first real user prompt in the rollout.
//
// Cached per session id -- a session's topic is fixed for its lifetime, and the
// alternative is rescanning ~100 summaries plus a multi-MB rollout on every
// focus event.
// ponytail: cache never expires, so a summary written after we fell back to the
// first prompt is not picked up until codex-titles.json is deleted.
// ---------------------------------------------------------------------------

const codexCachePath = join(stateDir, "codex-titles.json");
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const CODEX_PROMPT_WORDS = 10; // first-prompt fallback only; summary slugs are already short
const CODEX_PROMPT_CHARS = 48; // a pasted path is one "word", so cap characters too

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

// Newest first, so a session with several summaries yields the latest one.
function codexSummarySlug(sid) {
  const dir = join(CODEX_HOME, "memories", "rollout_summaries");
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort().reverse(); } catch { return ""; }
  for (const name of names) {
    let head;
    try { head = readFileSync(join(dir, name), "utf8").slice(0, 400); } catch { continue; }
    if (!head.includes(sid)) continue;
    // 2026-08-17T19-40-19-S2R1-idme_async_verification.md -> "idme async verification"
    return name
      .replace(/\.md$/, "")
      .replace(/^\d{4}-\d{2}-\d{2}T[\d-]+?-[A-Za-z0-9]{4}-/, "")
      .replace(/_/g, " ")
      .trim();
  }
  return "";
}

// sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<sid>.jsonl -- matched on the name, so
// no file is opened during the walk.
function codexRolloutPath(sid) {
  const root = join(CODEX_HOME, "sessions");
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(join(dir, e.name));
      else if (e.name.includes(sid) && e.name.endsWith(".jsonl")) return join(dir, e.name);
    }
  }
  return "";
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && c.text) || "").join(" ");
  return "";
}

// The first user turn is codex's own AGENTS.md injection; the human's prompt is
// the next one. Tagged blocks (<environment_context> etc.) are injections too.
function codexFirstPrompt(sid) {
  const path = codexRolloutPath(sid);
  if (!path) return "";
  let lines;
  try { lines = readFileSync(path, "utf8").split("\n", 400); } catch { return ""; }
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const payload = rec?.payload;
    if (!payload || payload.role !== "user") continue;
    const text = messageText(payload.content).trim();
    if (!text || text.startsWith("<") || text.startsWith("# AGENTS.md")) continue;
    // A prompt is a paragraph, not a label; keep enough to identify the session.
    return cap(limitWords(normalize(text), CODEX_PROMPT_WORDS), CODEX_PROMPT_CHARS);
  }
  return "";
}

function codexSessionTitle(pane) {
  const sid = pane.agent_session?.value;
  if (!sid || typeof sid !== "string") return "";
  const cache = readJson(codexCachePath, {});
  if (cache[sid]) return cache[sid];
  const title = codexSummarySlug(sid) || codexFirstPrompt(sid);
  if (title) {
    cache[sid] = title;
    try {
      mkdirSync(dirname(codexCachePath), { recursive: true });
      writeFileSync(codexCachePath, `${JSON.stringify(cache, null, 2)}\n`);
    } catch { /* cache is an optimization; a failed write just means we recompute */ }
  }
  return title;
}

function topicFor(pane, cfg) {
  let topic = limitWords(normalize(pane.terminal_title_stripped), cfg.max_words);
  const agent = String(pane.agent).toLowerCase();
  if (isGenericTopic(topic, pane.agent) && agent === "grok") {
    topic = limitWords(normalize(grokSessionTitle(pane)), cfg.max_words);
  }
  // codex's title is its cwd, which isGenericTopic cannot recognise as generic.
  if (agent === "codex") {
    const derived = limitWords(normalize(codexSessionTitle(pane)), cfg.max_words);
    if (derived) topic = derived;
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

function isDefaultCodexLabel(pane) {
  return String(pane.agent).toLowerCase() === "codex"
    && normalize(pane.label) === normalize(pane.terminal_title_stripped);
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
      const defaultCodexLabel = isDefaultCodexLabel(p);
      const prior = defaultCodexLabel && state.panes[p.pane_id]?.label === p.label
        ? undefined
        : state.panes[p.pane_id];
      const { label, pinned, write } = decide(
        prior,
        defaultCodexLabel ? "" : p.label,
        wanted,
      );
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

  const headerWrites = cfg.sync_space_headers
    ? syncSpaceHeaders(panes, state.space_headers || {})
    : { next: state.space_headers || {}, writes: 0 };
  saveState({ panes: nextPanes, tabs: nextTabs, space_headers: headerWrites.next });
  console.log(
    `synced: ${paneWrites} pane rename(s), ${tabWrites} tab rename(s), ` +
    `${headerWrites.writes} space header(s) ` +
    `[panes=${cfg.sync_panes} tabs=${cfg.sync_tabs} headers=${cfg.sync_space_headers} source=${cfg.tab_source}]`,
  );
}

// Agents-panel grouping tokens:
//   $space_header     first agent in a space (own line)
//   $kind_{claude|codex|grok|other}  brand glyph (pad on siblings)
//   $stat_{blocked|working|done|idle}  lifecycle glyph
//   $group_gap        trailing blank row between spaces
const SPACE_HEADER_SOURCE = "plugin:dan.pane-topic-sync";
const PAD = "\u2800\u2800";
const GAP = "\u2800";
const KIND_KEYS = ["kind_claude", "kind_codex", "kind_grok", "kind_other"];
const STAT_KEYS = ["stat_blocked", "stat_working", "stat_done", "stat_idle"];
const LEGACY_BADGE_KEYS = ["badge_blocked", "badge_working", "badge_done", "badge_idle"];
const TOKEN_KEYS = ["space_header", "group_gap", ...KIND_KEYS, ...STAT_KEYS, ...LEGACY_BADGE_KEYS];

export function badgeStatus(pane) {
  const s = pane.agent_status;
  if (s === "blocked") return "blocked";
  if (s === "working") return "working";
  if (s === "idle" && pane.seen === false) return "done";
  return "idle";
}

export function kindKey(agent) {
  switch (String(agent || "").toLowerCase()) {
    case "claude": return "claude";
    case "codex": return "codex";
    case "grok": return "grok";
    default: return "other";
  }
}

export function kindGlyph(agent) {
  switch (String(agent || "").toLowerCase()) {
    case "claude": return "✳";
    case "codex": return "●";
    case "grok": return "Ø";
    case "cursor": return "▸";
    case "opencode": return "◇";
    default: return "·";
  }
}

export function statusGlyph(status) {
  switch (status) {
    case "blocked": return "?";
    case "working": return ":";
    case "done": return "✓";
    default: return "○";
  }
}

export function emptyTokens() {
  return Object.fromEntries(TOKEN_KEYS.map((k) => [k, ""]));
}

export function spaceHeaderWanted({
  label,
  index,
  groupSize,
  lastGroup,
  agent,
  agent_status,
  seen,
}) {
  const status = badgeStatus({ agent_status, seen });
  const wanted = emptyTokens();
  if (index === 0) wanted.space_header = label;
  const pad = index === 0 ? "" : PAD;
  wanted[`kind_${kindKey(agent)}`] = `${pad}${kindGlyph(agent)}`;
  wanted[`stat_${status}`] = statusGlyph(status);
  if (index === groupSize - 1 && !lastGroup) wanted.group_gap = GAP;
  return wanted;
}

function readHeaderState(prior, paneId) {
  const v = prior[paneId];
  const base = emptyTokens();
  if (v == null) return base;
  if (typeof v === "string") return { ...base, space_header: v };
  for (const key of TOKEN_KEYS) base[key] = v[key] || "";
  return base;
}

function applyHeaderTokens(paneId, wanted, prev) {
  const same = TOKEN_KEYS.every((k) => (prev[k] || "") === (wanted[k] || ""));
  const args = ["pane", "report-metadata", paneId, "--source", SPACE_HEADER_SOURCE];
  for (const key of TOKEN_KEYS) {
    if (wanted[key]) args.push("--token", `${key}=${wanted[key]}`);
    else args.push("--clear-token", key);
  }
  if (same) return false;
  run(args);
  return true;
}

function syncSpaceHeaders(panes, prior) {
  const workspaces = json(["workspace", "list"])?.result?.workspaces ?? [];
  const byWs = new Map();
  for (const p of panes) {
    if (!p.agent) continue;
    if (!byWs.has(p.workspace_id)) byWs.set(p.workspace_id, []);
    byWs.get(p.workspace_id).push(p);
  }
  const groups = workspaces
    .map((ws) => ({ label: String(ws.label || "").trim(), agents: byWs.get(ws.workspace_id) || [] }))
    .filter((g) => g.agents.length);

  const next = {};
  let writes = 0;
  const seen = new Set();
  for (let g = 0; g < groups.length; g++) {
    const { label, agents } = groups[g];
    const lastGroup = g === groups.length - 1;
    for (let i = 0; i < agents.length; i++) {
      const pane = agents[i];
      const paneId = pane.pane_id;
      seen.add(paneId);
      const wanted = spaceHeaderWanted({
        label,
        index: i,
        groupSize: agents.length,
        lastGroup,
        agent: pane.agent,
        agent_status: pane.agent_status,
        seen: pane.seen,
      });
      next[paneId] = wanted;
      if (applyHeaderTokens(paneId, wanted, readHeaderState(prior, paneId))) writes++;
    }
  }
  for (const paneId of Object.keys(prior)) {
    if (seen.has(paneId)) continue;
    const prev = readHeaderState(prior, paneId);
    if (!TOKEN_KEYS.some((k) => prev[k])) continue;
    try {
      if (applyHeaderTokens(paneId, emptyTokens(), prev)) writes++;
    } catch {
      // pane gone
    }
  }
  return { next, writes };
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
