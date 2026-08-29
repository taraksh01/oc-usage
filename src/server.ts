/**
 * Server entry for oc-usage — dual-compatible with opencode (v1) and opencode2 (v2).
 *
 * v1 expects `{ id, server }`; v2 expects `{ id, setup }` (and optionally `tui:true`
 * to auto-load the TUI). Exporting both keys lets one file satisfy either validator
 * (both tolerate unknown keys) — same pattern used by opencode-tps-meter and
 * opencode-engram.
 *
 * This plugin has no server-side behavior; it exists so that a bare spec
 * `"@taraksh011/oc-usage"` in `opencode.json`'s `plugins` can auto-enable the TUI
 * via `tui:true` on v2, while staying installable on v1.
 */
const plugin: any = {
  id: "oc-usage",
  tui: true,
  // v1 server shape
  server: async () => ({}),
  // v2 promise server shape
  setup: async () => {},
  // also expose effect for Effect hosts (tolerated by Promise hosts)
  effect: () => ({}) as any,
}

export default plugin
