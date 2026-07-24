/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo, Show } from "solid-js"
import type { TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K"
  return String(n)
}

function countTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

interface SessionTotals {
  totalInput: number
  currentInput: number
  totalOutput: number
  currentOutput: number
  totalCost: number
  currentCost: number
  cacheRead: number
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
  return elapsed > 0 ? tokens / elapsed : 0
}

const plugin: TuiPluginModule = {
  id: "oc-usage",
  tui: async (api: TuiPluginApi) => {
    const [totals, setTotals] = createSignal<Map<string, SessionTotals>>(new Map())
    const [streams, setStreams] = createSignal<Map<string, StreamState>>(new Map())
    const partText = new Map<string, string>()

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
      const prevStream = streams().get(info.sessionID)
      const lastTPS = prevStream ? instantTPS(prevStream.buffer) : 0
      const lastAvgTPS = prevStream ? avgTPS(prevStream.tokens, prevStream.start) : 0
      const prev = totals().get(info.sessionID)
      const newInput = info.tokens.input || 0
      const newOutput = info.tokens.output || 0
      const t = {
        totalInput: newInput,
        currentInput: newInput - (prev?.totalInput ?? 0),
        totalOutput: (prev?.totalOutput ?? 0) + newOutput,
        currentOutput: newOutput,
        totalCost: (prev?.totalCost ?? 0) + (info.cost || 0),
        currentCost: info.cost || 0,
        cacheRead: (prev?.cacheRead ?? 0) + (info.tokens.cache?.read || 0),
        lastTPS,
        lastAvgTPS,
      }
      setTotals(p => { const n = new Map(p); n.set(info.sessionID, t); return n })
      setStreams(p => { const n = new Map(p); n.delete(info.sessionID); return n })
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
          const t = createMemo(() => totals().get(sid))
          const s = createMemo(() => streams().get(sid))
          const text = createMemo(() => {
            const totals = t()
            const stream = s()
            const parts: string[] = []
            if (totals) {
              let input = `\u2191${fmt(totals.totalInput)}`
              if (totals.currentInput > 0) input += ` [${fmt(totals.currentInput)}]`
              parts.push(input)
              if (totals.cacheRead > 0) parts.push(`\u21BB${fmt(totals.cacheRead)}`)
              let output = `\u2193${fmt(totals.totalOutput)}`
              if (totals.currentOutput > 0) output += ` [${fmt(totals.currentOutput)}]`
              else if (stream && stream.tokens > 0) output += ` [${fmt(stream.tokens)}]`
              parts.push(output)
              if (totals.totalCost > 0) {
                let cost = `$${totals.totalCost.toFixed(4)}`
                if (totals.currentCost > 0) cost += ` [$${totals.currentCost.toFixed(4)}]`
                parts.push(cost)
              }
            }
            if (stream && stream.tokens > 0) {
              const inst = instantTPS(stream.buffer)
              const avg = avgTPS(stream.tokens, stream.start)
              if (inst > 0) parts.push(`\u26A1${inst.toFixed(0)}`)
              if (avg > 0) parts.push(`\u2205${avg.toFixed(0)}`)
            } else if (totals && totals.lastAvgTPS > 0) {
              if (totals.lastTPS > 0) parts.push(`\u26A1${totals.lastTPS.toFixed(0)}`)
              parts.push(`\u2205${totals.lastAvgTPS.toFixed(0)}`)
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
      partText.clear()
      setTotals(new Map())
      setStreams(new Map())
    })
  },
}

export default plugin
