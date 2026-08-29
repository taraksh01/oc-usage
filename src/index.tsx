/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo, Show } from "solid-js"
import type { TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"

// ---------------------------------------------------------------------------
// Structural v2 TUI types — mirrors @opencode-ai/plugin/tui@beta but declared
// locally so we can build with the v1 SDK installed. Verified against
// 0.0.0-beta-18684. Using structural types avoids needing both SDK versions.
// ---------------------------------------------------------------------------

type V2Rgba = any
interface V2ResolvedTheme {
  readonly text: {
    readonly default: V2Rgba
    readonly subdued: V2Rgba
    readonly feedback: Record<string, { readonly default: V2Rgba }>
  }
}

interface V2SlotInput {
  readonly sessionID?: string
  readonly mode?: "normal" | "shell"
}
interface V2SlotClaim {
  readonly render: (input: V2SlotInput) => any
  readonly append?: string
  readonly prepend?: string
  readonly before?: string
  readonly after?: string
  readonly replace?: string
}
interface V2TuiContext {
  readonly options?: Readonly<Record<string, any>>
  readonly theme: V2ResolvedTheme
  readonly data: {
    readonly on: <T extends string>(type: T, handler: (event: any) => void) => () => void
    readonly listen?: (handler: (event: any) => void) => () => void
    readonly session?: any
  }
  readonly ui: {
    readonly slot: (claim: V2SlotClaim) => () => void
    readonly router?: any
    readonly toast?: any
    readonly dialog?: any
  }
  readonly storage: {
    readonly store: <V extends object>(key: string, opts: { readonly initial: V }) => readonly [V, (mut: (draft: V) => void) => Promise<void>]
    readonly memory: <V extends object>(key: string, opts: { readonly initial: V }) => readonly [V, (mut: (draft: V) => void) => void]
  }
  readonly keymap?: any
  readonly client?: any
  readonly renderer?: any
  readonly app?: any
}

type V2Cleanup = () => void | Promise<void>

function fmt(n: number): string {
  if (n >= 1_000_000_000_000) return (n / 1_000_000_000_000).toFixed(1) + "T"
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B"
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K"
  return String(n)
}

function countTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

interface Cumulative {
  totalInput: number
  totalOutput: number
  totalCost: number
  cacheRead: number
  currentInput: number
  currentOutput: number
  currentCache: number
  lastTPS: number
  lastAvgTPS: number
}

interface StreamState {
  tokens: number
  start: number
  buffer: Array<{ ts: number; count: number }>
}

const WINDOW_MS = 1000
const MIN_DUR = 0.3

function instantTPS(buffer: Array<{ ts: number; count: number }>): number {
  const now = Date.now()
  const cutoff = now - WINDOW_MS
  let tokens = 0, oldest = now
  for (const e of buffer) {
    if (e.ts >= cutoff) { tokens += e.count; if (e.ts < oldest) oldest = e.ts }
  }
  if (tokens === 0) return 0
  return tokens / Math.max((now - oldest) / 1000, MIN_DUR)
}

function avgTPS(tokens: number, start: number): number {
  const elapsed = (Date.now() - start) / 1000
  if (elapsed < MIN_DUR) return 0
  return tokens / elapsed
}

function emptyCumulative(): Cumulative {
  return { totalInput: 0, totalOutput: 0, totalCost: 0, cacheRead: 0, currentInput: 0, currentOutput: 0, currentCache: 0, lastTPS: 0, lastAvgTPS: 0 }
}

function kvKey(sid: string): string {
  return `oc-usage/${sid}`
}

const tuiV1: TuiPluginApi extends never ? never : (api: TuiPluginApi) => Promise<void> = async (api: TuiPluginApi) => {
  const [totals, setTotals] = createSignal<Map<string, Cumulative>>(new Map())
  const [streams, setStreams] = createSignal<Map<string, StreamState>>(new Map())
  const partText = new Map<string, string>()
  const countedMessages = new Set<string>()

  function loadFromKV(sid: string): Cumulative {
    if (!api.kv.ready) return emptyCumulative()
    return api.kv.get<Cumulative>(kvKey(sid)) ?? emptyCumulative()
  }

  function saveToKV(sid: string, t: Cumulative) {
    if (api.kv.ready) api.kv.set(kvKey(sid), t)
  }

  function recordDelta(sid: string, delta: number) {
    if (delta <= 0) return
    const prev = streams().get(sid)
    const ts = Date.now()
    const tokens = (prev?.tokens ?? 0) + delta
    const start = prev?.start ?? ts
    const buffer = [...(prev?.buffer ?? []), { ts, count: delta }]
    const cutoff = ts - WINDOW_MS
    while (buffer.length > 0 && buffer[0].ts < cutoff) buffer.shift()
    if (buffer.length > 200) buffer.splice(0, buffer.length - 200)
    setStreams(p => { const n = new Map(p); n.set(sid, { tokens, start, buffer }); return n })
  }

  const disposers: Array<() => void> = []

  disposers.push(api.event.on("message.part.delta", (event) => {
    if (event.properties.field !== "text") return
    const { sessionID, messageID, partID, delta } = event.properties
    if (!delta) return
    const key = `${sessionID}:${messageID}:${partID}`
    const prev = partText.get(key) ?? ""
    partText.set(key, prev + delta)
    const tokens = countTokens(prev + delta) - countTokens(prev)
    if (tokens > 0) recordDelta(sessionID, tokens)
  }))

  disposers.push(api.event.on("message.part.updated", (event) => {
    const { part } = event.properties
    if (!part || (part.type !== "text" && part.type !== "reasoning")) return
    const key = `${part.sessionID}:${part.messageID}:${part.id}`
    const text = part.text ?? ""
    if (!text) return
    const prev = partText.get(key) ?? ""
    if (prev.length > 0 && text.startsWith(prev) && text.length > prev.length) {
      const tokens = countTokens(text) - countTokens(prev)
      if (tokens > 0) recordDelta(part.sessionID, tokens)
    } else if (prev.length === 0) {
      const tokens = countTokens(text)
      if (tokens > 0) recordDelta(part.sessionID, tokens)
    }
    partText.set(key, text)
  }))

  disposers.push(api.event.on("message.updated", (event) => {
    const info = event.properties.info
    if (info.role !== "assistant") return
    if (!info.time.completed) return
    if (countedMessages.has(info.id)) return
    countedMessages.add(info.id)
    const sid = info.sessionID
    const prev = totals().get(sid) ?? loadFromKV(sid)
    const newInput = info.tokens.input || 0
    const newOutput = (info.tokens.output || 0) + (info.tokens.reasoning || 0)
    const prevStream = streams().get(sid)
    const cacheHit = info.tokens.cache?.read || 0
    const t = {
      totalInput: prev.totalInput + newInput,
      currentInput: newInput,
      totalOutput: prev.totalOutput + newOutput,
      currentOutput: newOutput,
      totalCost: prev.totalCost + (info.cost || 0),
      cacheRead: prev.cacheRead + cacheHit,
      currentCache: cacheHit,
      lastTPS: prevStream ? instantTPS(prevStream.buffer) : 0,
      lastAvgTPS: prevStream ? avgTPS(prevStream.tokens, prevStream.start) : 0,
    }
    setTotals(p => { const n = new Map(p); n.set(sid, t); return n })
    saveToKV(sid, t)
    const prefix = `${sid}:${info.id}:`
    for (const k of partText.keys()) { if (k.startsWith(prefix)) partText.delete(k) }
    setStreams(p => { const n = new Map(p); n.delete(sid); return n })
  }))

  disposers.push(api.event.on("session.idle", (event) => {
    const sid = event.properties.sessionID
    if (!sid) return
    setStreams(p => { const n = new Map(p); n.delete(sid); return n })
  }))

  api.slots.register({
    order: 20,
    slots: {
      session_prompt_right(_ctx, props) {
        const sid = props.session_id
        const c = createMemo(() => {
          const m = totals()
          return m.get(sid) ?? loadFromKV(sid)
        })
        const s = createMemo(() => streams().get(sid))
        const text = createMemo(() => {
          const cum = c()
          const stream = s()
          const parts: string[] = []
          parts.push(`\u2191${fmt(cum.totalInput)}`)
          parts.push(`[${fmt(cum.currentInput)}]`)
          if (cum.cacheRead > 0) {
            let cache = `\u21BB ${fmt(cum.cacheRead)}`
            if (cum.currentCache > 0) cache += ` [${fmt(cum.currentCache)}]`
            parts.push(cache)
          }
          let output = `\u2193${fmt(cum.totalOutput)}`
          if (stream && stream.tokens >= 0) output += ` [${fmt(stream.tokens)}]`
          else output += ` [${fmt(cum.currentOutput)}]`
          parts.push(output)
          parts.push(`$${cum.totalCost.toFixed(4)}`)
          if (stream && stream.tokens >= 0) {
            const inst = instantTPS(stream.buffer)
            const avg = avgTPS(stream.tokens, stream.start)
            parts.push(`\u26A1${inst.toFixed(0)}`)
            parts.push(`\u2205 ${avg.toFixed(0)}`)
          } else {
            parts.push(`\u26A1${cum.lastTPS.toFixed(0)}`)
            parts.push(`\u2205 ${cum.lastAvgTPS.toFixed(0)}`)
          }
          return parts.length > 0 ? parts.join(" ") : ""
        })
        const txt = text()
        return (
          <Show when={txt}>
            <box flexDirection="row">
              <text>{txt}</text>
            </box>
          </Show>
        )
      },
    },
  })

  api.lifecycle.onDispose(() => {
    for (const d of disposers) d()
    for (const [sid, t] of totals()) saveToKV(sid, t)
    partText.clear()
    setTotals(new Map())
    setStreams(new Map())
  })
}

// ---------------------------------------------------------------------------
// v2 TUI implementation for opencode2 (CLI plugin via @opencode-ai/plugin/tui@beta)
// Uses structural types so we stay buildable with the v1 SDK.
// ---------------------------------------------------------------------------

async function setupV2(ctx: V2TuiContext): Promise<V2Cleanup | void> {
  const [totals, setTotals] = createSignal<Map<string, Cumulative>>(new Map())
  const [streams, setStreams] = createSignal<Map<string, StreamState>>(new Map())
  const countedSteps = new Set<string>()

  // Durable storage — v2 `storage.store` is the successor to v1's `kv`
  let persistedStore: any = null
  let storeEntries: Record<string, Cumulative> | null = null
  let setStore: ((mut: (draft: any) => void) => Promise<void>) | null = null
  try {
    const anyCtx: any = ctx as any
    if (anyCtx.storage?.store) {
      const [store, setter] = anyCtx.storage.store("oc-usage", { initial: { entries: {} as Record<string, Cumulative> } }) as readonly [any, any]
      persistedStore = store as any
      storeEntries = (store as any).entries as Record<string, Cumulative>
      setStore = setter as any
      if (storeEntries && typeof storeEntries === "object") {
        const m = new Map<string, Cumulative>()
        for (const [k, v] of Object.entries(storeEntries)) if (v) m.set(k, v as Cumulative)
        if (m.size > 0) setTotals(m)
      }
    } else if (anyCtx.storage?.memory) {
      // fallback to memory if store not available (older beta)
      const [store] = anyCtx.storage.memory("oc-usage-mem", { initial: { entries: {} as Record<string, Cumulative> } }) as readonly [any, any]
      persistedStore = store as any
      storeEntries = (store as any).entries as Record<string, Cumulative>
    }
  } catch {}

  function loadFromStore(sid: string): Cumulative {
    // Prefer reactive store so updates are tracked; fall back to signal map
    if (persistedStore && persistedStore.entries?.[sid]) return persistedStore.entries[sid] as Cumulative
    if (storeEntries && storeEntries[sid]) return storeEntries[sid]
    const m = totals().get(sid)
    if (m) return m
    return emptyCumulative()
  }
  function saveToStore(sid: string, t: Cumulative) {
    if (setStore) {
      try { setStore((draft: any) => { draft.entries[sid] = t }) } catch {}
      if (storeEntries) storeEntries[sid] = t
    } else if (storeEntries) {
      storeEntries[sid] = t
    }
  }

  function recordDelta(sid: string, delta: number) {
    if (delta <= 0) return
    const prev = streams().get(sid)
    const ts = Date.now()
    const tokens = (prev?.tokens ?? 0) + delta
    const start = prev?.start ?? ts
    const buffer = [...(prev?.buffer ?? []), { ts, count: delta }]
    const cutoff = ts - WINDOW_MS
    while (buffer.length > 0 && buffer[0].ts < cutoff) buffer.shift()
    if (buffer.length > 200) buffer.splice(0, buffer.length - 200)
    setStreams(p => { const n = new Map(p); n.set(sid, { tokens, start, buffer }); return n })
  }

  const disposers: Array<() => void> = []

  // Helper to extract sid/delta from both v2 data envelope and possible v1-ish fallback
  const on = (ctx as any).data?.on as undefined | ((type: string, handler: (e: any) => void) => () => void)

  if (on) {
    disposers.push(on("session.text.delta", (event: any) => {
      const sid: string | undefined = event?.data?.sessionID ?? event?.properties?.sessionID
      const delta: string | undefined = event?.data?.delta ?? event?.properties?.delta
      if (!sid || !delta) return
      const tokens = countTokens(delta)
      if (tokens > 0) recordDelta(sid, tokens)
    }))
    disposers.push(on("session.reasoning.delta", (event: any) => {
      const sid: string | undefined = event?.data?.sessionID ?? event?.properties?.sessionID
      const delta: string | undefined = event?.data?.delta ?? event?.properties?.delta
      if (!sid || !delta) return
      const tokens = countTokens(delta)
      if (tokens > 0) recordDelta(sid, tokens)
    }))

    disposers.push(on("session.step.ended", (event: any) => {
      const data: any = event?.data ?? event?.properties ?? {}
      const sid: string | undefined = data.sessionID
      if (!sid) return
      const stepId: string | undefined = data.assistantMessageID ?? event?.id ?? data.id
      if (stepId && countedSteps.has(stepId)) return
      if (stepId) countedSteps.add(stepId)
      const tokens: any = data.tokens ?? {}
      const newInput: number = typeof tokens.input === "number" ? tokens.input : 0
      const newOutput: number = (typeof tokens.output === "number" ? tokens.output : 0) + (typeof tokens.reasoning === "number" ? tokens.reasoning : 0)
      const cacheHit: number = tokens.cache?.read ?? 0
      const cost: number = typeof data.cost === "number" ? data.cost : 0
      const prev = totals().get(sid) ?? loadFromStore(sid)
      const prevStream = streams().get(sid)
      const t: Cumulative = {
        totalInput: prev.totalInput + newInput,
        currentInput: newInput,
        totalOutput: prev.totalOutput + newOutput,
        currentOutput: newOutput,
        totalCost: prev.totalCost + cost,
        cacheRead: prev.cacheRead + cacheHit,
        currentCache: cacheHit,
        lastTPS: prevStream ? instantTPS(prevStream.buffer) : 0,
        lastAvgTPS: prevStream ? avgTPS(prevStream.tokens, prevStream.start) : 0,
      }
      setTotals(p => { const n = new Map(p); n.set(sid, t); return n })
      saveToStore(sid, t)
      setStreams(p => { const n = new Map(p); n.delete(sid); return n })
    }))

    disposers.push(on("session.idle", (event: any) => {
      const sid: string | undefined = event?.data?.sessionID ?? event?.properties?.sessionID
      if (!sid) return
      setStreams(p => { const n = new Map(p); n.delete(sid); return n })
    }))

    for (const type of ["session.step.failed", "session.execution.interrupted", "session.execution.failed"] as const) {
      try {
        disposers.push(on(type, (event: any) => {
          const sid: string | undefined = event?.data?.sessionID
          if (!sid) return
          setStreams(p => { const n = new Map(p); n.delete(sid); return n })
        }))
      } catch {}
    }
  }

  let removeSlot: (() => void) | undefined
  try {
    const ui: any = (ctx as any).ui
    if (ui?.slot) {
      removeSlot = ui.slot({
        append: "prompt.footer.status",
        render: (input: V2SlotInput) => {
          const sid = input.sessionID
          if (!sid) return (<box flexShrink={0} />) as any
          const c = createMemo(() => {
            const m = totals()
            return m.get(sid) ?? (persistedStore?.entries?.[sid] as Cumulative | undefined) ?? (storeEntries?.[sid] as Cumulative | undefined) ?? emptyCumulative()
          })
          const s = createMemo(() => streams().get(sid))
          const text = createMemo(() => {
            const cum = c()
            const stream = s()
            const parts: string[] = []
            parts.push(`\u2191${fmt(cum.totalInput)}`)
            parts.push(`[${fmt(cum.currentInput)}]`)
            if (cum.cacheRead > 0) {
              let cache = `\u21BB ${fmt(cum.cacheRead)}`
              if (cum.currentCache > 0) cache += ` [${fmt(cum.currentCache)}]`
              parts.push(cache)
            }
            let output = `\u2193${fmt(cum.totalOutput)}`
            if (stream && stream.tokens >= 0) output += ` [${fmt(stream.tokens)}]`
            else output += ` [${fmt(cum.currentOutput)}]`
            parts.push(output)
            parts.push(`$${cum.totalCost.toFixed(4)}`)
            if (stream && stream.tokens >= 0) {
              const inst = instantTPS(stream.buffer)
              const avg = avgTPS(stream.tokens, stream.start)
              parts.push(`\u26A1${inst.toFixed(0)}`)
              parts.push(`\u2205 ${avg.toFixed(0)}`)
            } else {
              parts.push(`\u26A1${cum.lastTPS.toFixed(0)}`)
              parts.push(`\u2205 ${cum.lastAvgTPS.toFixed(0)}`)
            }
            return parts.join(" ")
          })
          const txt = text()
          return (
            <Show when={txt}>
              <box flexDirection="row">
                <text>{txt}</text>
              </box>
            </Show>
          ) as any
        },
      })
    }
  } catch {}

  // Cleanup is returned — v2 host calls it when plugin unloads; v1 host ignores it
  return () => {
    for (const d of disposers) try { d() } catch {}
    if (removeSlot) try { removeSlot() } catch {}
    for (const [sid, t] of totals()) saveToStore(sid, t)
  }
}

/**
 * Dual-host TUI module.
 * v1 reads `tui`; v2 reads `setup`. Both hosts ignore the key they don't know,
 * so one file serves `opencode` and `opencode2`.
 * (See opencode-tps-meter's DualHostTuiModule for the same pattern.)
 */
type DualTuiModule = TuiPluginModule & { setup: typeof setupV2 }

const plugin: DualTuiModule = {
  id: "oc-usage",
  tui: tuiV1 as any,
  setup: setupV2,
}

export default plugin
