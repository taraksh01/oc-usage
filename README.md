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

Data persists across restarts via TuiKV.

## Install

```json
// ~/.config/opencode/tui.jsonc
{
  "plugins": ["@taraksh011/oc-usage"]
}
```

Then restart OpenCode.
