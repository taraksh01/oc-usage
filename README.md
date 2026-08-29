# oc-usage

OpenCode TUI plugin — displays per-session token usage, cost, and TPS in the prompt bar.

```
↑1.2K [450] ↓3.5K [2.1K] $0.0214 ⚡45 ∅38
```

- `↑ total [current]` — input tokens (cumulative / last message)
- `↻ total [current]` — cache read tokens (cumulative / last message)
- `↓ total [current]` — output tokens including reasoning (cumulative / last message)
- `$cost` — total session cost
- `⚡tps` — instant tokens/sec (1s rolling window)
- `∅ tps` — average tokens/sec (across streaming duration)

Data persists across restarts (v1 via TuiKV, v2 via `storage.store`).

## Install

### opencode (v1 — `opencode`)

```jsonc
// ~/.config/opencode/tui.jsonc  (or .opencode/tui.jsonc / opencode.json)
{
  "plugins": ["@taraksh011/oc-usage"]
}
```

Restart `opencode`. The TUI resolves `exports["./tui"]` to the same dual module, so v1
reads `tui` and ignores `setup`.

### opencode2 (v2 beta — `opencode2`)

`opencode` and `opencode2` can be installed side-by-side (see
https://opencode.ai/v2/docs/migrate-v1). This package ships one dual TUI entry
(`{ id, tui, setup }`); v2 reads `setup` and ignores `tui`.

**CLI plugin (recommended — works with remote servers):**

```jsonc
// ~/.config/opencode/cli.json  (global, auto-migrated from tui.json on first v2 run)
{
  "plugins": ["@taraksh011/oc-usage"]
}
```

Or with the CLI:

```sh
opencode2 plugin add @taraksh011/oc-usage
# verify
opencode2 plugin list | grep oc-usage
```

Per spec, a file spec must point at the built file: `file:///path/to/dist/index.js`.

**Server + auto TUI (single entry):**

```jsonc
// opencode.jsonc  (project or ~/.config/opencode/opencode.jsonc)
{
  "plugins": ["@taraksh011/oc-usage"]  // resolves to exports["./server"] (dual) with tui:true
}
```

The `server` entry (`exports["./server"]`) is a no-op `setup`/`server` with
`tui:true`, so adding the bare spec to `plugins` also loads the TUI via
`prompt.footer.status` (v2 equivalent of `session_prompt_right`). No subpath is
needed — `opencode2` treats every `plugins` string as a package name.

Then restart `opencode2`.

### From source / local checkout

```jsonc
// v1
{ "plugins": ["file:///home/me/oc-usage"] }           // resolves ./tui via package.json exports
// v2 TUI
{ "plugins": ["file:///home/me/oc-usage/dist/index.js"] } // or .../dist/tui.js alias
```

> Do not use `"@taraksh011/oc-usage/v2"` in `plugins` — v2 parses that as a GitHub
> repo spec — and `tui.json`/`tui.jsonc` are no longer read by `opencode2` (replaced
> by `cli.json`). The bare package name is the whole story.
