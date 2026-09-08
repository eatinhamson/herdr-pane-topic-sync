# Pane Topic Sync

A [herdr](https://herdr.dev) plugin that auto-names your panes and tabs after
what each agent is actually working on — no more tabs labeled `1`, `2`, `3`.

On every relevant herdr event it:

1. **Renames each agent pane** to its live topic — the `terminal_title_stripped`
   that Claude Code (and other agents) emit via the terminal title. Grok's OSC
   title stays `grok`, so a Grok pane falls back to `generated_title` in that
   session's `summary.json`. With `show_agent_labels_on_pane_borders = true` in
   your herdr config, that topic shows right on the pane border.
2. **Renames each tab** to the topic of its **first pane** (top-left, reading
   order). If the first pane is a plain shell, the first *agent* pane's topic is
   used instead, so a tab is never named after a shell prompt.

Plain (non-agent) shell panes are left untouched.

## How it works

- Subscribes to `pane.*` / `tab.focused` / `workspace.focused` events (see
  `herdr-plugin.toml`). The key trigger is `pane.agent_status_changed`, which
  fires when an agent flips idle↔working — i.e. when it sets a fresh topic.
- Deliberately does **not** subscribe to `*.renamed` events, so its own renames
  can't feed back into a loop.
- Gates all writes through a state file (`$HERDR_PLUGIN_STATE_DIR/pane-topic-sync-state.json`),
  so `rename` is only called when a topic actually changed — no churn.
- "First pane" is resolved from `herdr pane layout` rect coordinates, sorted by
  `(y, x)`, so it's the visually top-left pane regardless of split order.

## Install

Local (development):

```sh
git clone <this-repo> ~/repos/herdr-pane-topic-sync
herdr plugin link ~/repos/herdr-pane-topic-sync
herdr server reload-config
```

Requires [bun](https://bun.sh) on `PATH` (herdr runs `bun sync-labels.js`).

To see topics on pane borders too, add to `~/.config/herdr/config.toml`:

```toml
[ui]
show_agent_labels_on_pane_borders = true
```

## Manual sync / debugging

```sh
herdr plugin action invoke dan.pane-topic-sync.sync
herdr plugin log list --plugin dan.pane-topic-sync --limit 5
```

## Configuration

Optional. Drop a `config.toml` in the plugin's config dir (find it with
`herdr plugin config-dir dan.pane-topic-sync`). All keys are optional; see
[`examples/default-config.toml`](examples/default-config.toml) for the full
documented set. Summary:

| Key | Default | Meaning |
|-----|---------|---------|
| `sync_panes` | `true` | Rename agent panes to their topic. |
| `sync_tabs` | `true` | Rename tabs. |
| `tab_source` | `"first"` | Which pane names a multi-pane tab: `"first"` (top-left) or `"active"` (the pane you last focused *within that tab* — herdr tracks this per tab). |
| `max_label_length` | `60` | Truncate longer labels (applied after formatting). `0` = no limit. |
| `max_pane_label_length` | `max_label_length` | Pane-only cap. `0` = no limit. |
| `max_tab_label_length` | `max_label_length` | Tab-only cap. `0` = no limit. |
| `tab_format` | `"{topic}"` | Template; tokens `{topic}` `{agent}` `{workspace}` `{n}` (tab switch number). |
| `pane_format` | `"{topic}"` | Template; tokens `{topic}` `{agent}` `{workspace}`. |
| `sync_space_headers` | `true` | Stamp Agents-panel `$space_header` / `$badge_*` / `$group_gap`. |

Examples: `tab_format = "{n}· {topic}"` keeps the tab switch number;
`pane_format = "{agent}: {topic}"` prefixes the agent name.

### Manual renames

Hand-rename a pane or tab (`herdr pane rename` / `herdr tab rename`, or the
UI) and the plugin leaves it alone from then on — it tracks the label it last
wrote per pane/tab in its state file, so a live label that no longer matches
what it wrote is recognized as a human edit and pinned, instead of being
clobbered on the next topic change. Anything you haven't touched keeps
auto-refreshing as usual. There's no unpin command yet; to hand a pinned
pane/tab back to auto-sync, delete its entry from
`$HERDR_PLUGIN_STATE_DIR/pane-topic-sync-state.json` (its `panes`/`tabs`
maps).

## Agents panel grouping

The plugin also reports display-only pane tokens so the Herdr Agents list can
group by Space with kind + status glyphs. That half is **not visible** unless
`~/.config/herdr/config.toml` includes the rows in
[`examples/herdr-sidebar.toml`](examples/herdr-sidebar.toml). Merge that file,
then `herdr server reload-config`.

Per Space, in sidebar order:

1. `$space_header` — workspace label on its own line (first agent of a Space).
2. `$kind_{claude|codex|grok|other}` — brand glyph (`✳` / `●` / `Ø`). Sibling
   rows get a two-cell pad so every agent lines up under the heading (Herdr
   continuation-indents the group leader's agent row).
3. `$stat_{blocked|working|done|idle}` — lifecycle glyph (`?` / `:` / `✓` /
   `○`).
4. `$group_gap` — blank row after the last agent of each Space except the last.

Tokens refresh on the same events as pane/tab names. Self-check:
`bun test-space-headers.js`.

## License

MIT
