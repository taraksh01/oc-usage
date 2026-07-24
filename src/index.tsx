/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo, Show } from "solid-js"
import type { TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K"
  return String(n)
}

function fmtCost(c: number): string {
  if (c >= 0.01) return "$" + c.toFixed(3)
  if (c > 0) return "$" + c.toFixed(4)
  return ""
}

function countTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

interface SessionTotals {
  input: number
  output: number
  cost: number
  cacheRead: number
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
  return elapsed > 0 ? tokens / elapsed : 0
}

const plugin: TuiPluginModule = {
  id: "oc-usage",
  tui: async (api: TuiPluginApi) => {
    const [totals, setTotals] = createSignal<Map<string, SessionTotals>>(new Map())
    const [streams, setStreams] = createSignal<Map<string, StreamState>>(new Map())
    const partText = new Map<string, string>()
    const currentMessage = new Map<string, string>()

    function getTotals(sid: string): SessionTotals {
      const m = totals()
      let t = m.get(sid)
      if (!t) { t = { input: 0, output: 0, cost: 0, cacheRead: 0 }; setTotals(p => { const n = new Map(p); n.set(sid, t!); return n }) }
      return t
    }

    function getStream(sid: string): StreamState {
      const m = streams()
      let s = m.get(sid)
      if (!s) { s = { tokens: 0, start: 0, buffer: [] }; setStreams(p => { const n = new Map(p); n.set(sid, s!); return n }) }
      return s
    }

    function recordDelta(sid: string, delta: number) {
      if (delta <= 0) return
      const s = getStream(sid)
      if (s.start === 0) s.start = Date.now()
      s.tokens += delta
      const ts = Date.now()
      s.buffer.push({ ts, count: delta })
      const cutoff = ts - WINDOW_MS
      while (s.buffer.length > 0 && s.buffer[0].ts < cutoff) s.buffer.shift()
      if (s.buffer.length > 200) s.buffer.splice(0, s.buffer.length - 200)
      setStreams(p => { const n = new Map(p); n.set(sid, s); return n })
    }

    const disposers: Array<() => void> = []

    disposers.push(api.event.on("message.part.delta", (event) => {
      if (event.properties.field !== "text") return
      const { sessionID, messageID, partID, delta } = event.properties
      if (!delta) return
      currentMessage.set(sessionID, messageID)
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
      currentMessage.delete(info.sessionID)
      const t = getTotals(info.sessionID)
      t.input = info.tokens.input || 0
      t.output += info.tokens.output || 0
      t.cost += info.cost || 0
      t.cacheRead += info.tokens.cache?.read || 0
      setTotals(p => { const n = new Map(p); n.set(info.sessionID, t); return n })
      setStreams(p => { const n = new Map(p); n.delete(info.sessionID); return n })
    }))

    disposers.push(api.event.on("session.idle", (event) => {
      const sid = event.properties.sessionID
      if (!sid) return
      setTotals(p => { const n = new Map(p); n.delete(sid); return n })
      setStreams(p => { const n = new Map(p); n.delete(sid); return n })
    }))

    api.slots.register({
      order: 20,
      slots: {
        session_prompt_right(_ctx, props) {
          const sid = props.session_id
          const t = createMemo(() => totals().get(sid))
          const s = createMemo(() => streams().get(sid))
          const text = createMemo(() => {
            const totals = t()
            const stream = s()
            const parts: string[] = []
            if (totals) {
              parts.push(`\u2192${fmt(totals.input)}`)
              if (totals.cacheRead > 0) parts.push(`\u21BB${fmt(totals.cacheRead)}`)
              parts.push(`\u2190${fmt(totals.output)}`)
              if (totals.cost > 0) parts.push(fmtCost(totals.cost))
            }
            if (stream && stream.tokens > 0) {
              const inst = instantTPS(stream.buffer)
              const avg = avgTPS(stream.tokens, stream.start)
              if (inst > 0) parts.push(`\u26A1${inst.toFixed(0)}`)
              if (avg > 0) parts.push(`\u2205${avg.toFixed(0)}`)
            }
            return parts.length > 0 ? parts.join(" ") : ""
          })
          const txt = text()
          return (
            <Show when={txt}>
              <box flexShrink={0} flexDirection="row">
                <text>{txt}</text>
              </box>
            </Show>
          )
        },
      },
    })

    api.lifecycle.onDispose(() => {
      for (const d of disposers) d()
    })
  },
}

export default plugin
