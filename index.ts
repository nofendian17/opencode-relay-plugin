import { Plugin } from "@opencode/plugin"
import { appendFile } from "node:fs/promises"

interface RelayOptions {
  url?: string | string[]
  debug?: boolean
}

const DEBUG_LOG = "/tmp/opencode-relay.log"

const ZEN_PREFIX = "https://opencode.ai/zen/"

type Logger = (message: string, extra?: Record<string, unknown>) => void

function relayPath(url: URL): string {
  const path = url.pathname + url.search
  return path === "" ? "/" : path
}

function normalizeRelays(raw: string | string[] | undefined): string[] {
  const list = raw ?? process.env.RELAY_URL?.split(",") ?? []
  const arr = Array.isArray(list) ? list : [list]
  const seen = new Set<string>()
  for (const item of arr) {
    if (typeof item !== "string") continue
    const trimmed = item.trim().replace(/\/+$/, "")
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
  }
  return [...seen]
}

function createRoundRobin(count: number): () => number {
  let idx = 0
  return () => {
    const cur = idx
    idx = (idx + 1) % count
    return cur
  }
}

function buildRelayOrigins(relays: readonly string[]): ReadonlySet<string> {
  const origins = new Set<string>()
  for (const relay of relays) {
    try {
      origins.add(new URL(relay).origin)
    } catch {
      origins.add(relay)
    }
  }
  return origins
}

function isRelayFailureStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function withDuplex(init: RequestInit, bodyBuf: ArrayBuffer | undefined): RequestInit {
  return bodyBuf ? ({ ...init, duplex: "half" } as RequestInit) : init
}

// Returns true if the signal was aborted and the caller should return early.
async function failoverToDirect(
  event: { response: Response },
  relays: readonly string[],
  start: number,
  orig: { origin: string; path: string },
  method: string,
  headers: Headers,
  bodyBuf: ArrayBuffer | undefined,
  signal: AbortSignal | undefined,
  directFetch: typeof fetch,
  log: Logger,
  emit: Logger,
): Promise<boolean> {
  let lastStatus = event.response.status
  // Try the other relays in the pool (the first was already tried in http.request).
  for (let i = 1; i < relays.length; i++) {
    if (signal?.aborted) return true
    const relay = relays[(start + i) % relays.length]
    const h = new Headers(headers)
    h.set("x-relay-target", orig.origin)
    h.set("x-relay-path", orig.path)
    log(`retry ${method} ${orig.origin} via next relay`, { relay, prevStatus: lastStatus })
    try {
      const res = await directFetch(relay, withDuplex({ method, headers: h, body: bodyBuf, signal }, bodyBuf))
      if (!isRelayFailureStatus(res.status)) {
        event.response = res
        return false
      }
      lastStatus = res.status
      try {
        await res.body?.cancel()
      } catch {
        // ignore
      }
    } catch (e) {
      if (signal?.aborted) return true
      log("relay retry network error", { relay, error: String(e) })
      continue
    }
  }

  // All relays failed -> direct fallback (v1 parity).
  emit("relay fallback to direct", { target: orig.origin, path: orig.path, status: lastStatus })
  if (signal?.aborted) return true
  try {
    event.response = await directFetch(orig.origin + orig.path, withDuplex({ method, headers, body: bodyBuf, signal }, bodyBuf))
  } catch (e) {
    log("direct fallback failed, keeping relay response", { error: String(e) })
  }
  return false
}

type RelayFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Direct port of the v1 relay fetch: forward to the relay endpoint with
 * `x-relay-target` / `x-relay-path` (original method preserved),
 * round-robin across the pool, fail over on 429/5xx + network errors,
 * fall back to direct.
 * Used for out-of-session traffic (global fetch patch for Zen).
 */
function createRelayFetch(
  relays: readonly string[],
  pickIndex: () => number,
  direct: typeof fetch,
  debug: boolean,
  log: Logger,
  emit: Logger,
): RelayFetch {
  return async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = input instanceof Request && !init ? input : new Request(input, init)
    let url: URL
    try {
      url = new URL(req.url)
    } catch {
      return direct(input, init)
    }

    const originalHeaders = new Headers(req.headers)
    const method = req.method
    const signal = req.signal

    // Buffer the body once so relay retries + direct fallback can reuse it
    // (streams can only be consumed once).
    let bodyBuf: ArrayBuffer | undefined
    if (req.body) {
      try {
        bodyBuf = await req.arrayBuffer()
      } catch (e) {
        if (debug) log(`relay body buffer failed, direct fallback`, { error: String(e) })
        return direct(input, init)
      }
    }

    const start = pickIndex()
    let lastError: unknown
    for (let attempt = 0; attempt < relays.length; attempt++) {
      const relay = relays[(start + attempt) % relays.length]
      const headers = new Headers(originalHeaders)
      headers.set("x-relay-target", url.origin)
      headers.set("x-relay-path", relayPath(url))
      if (debug) log(`${method} ${url.origin}${url.pathname}`, { relay, attempt: attempt + 1 })

      try {
        const res = await direct(relay, withDuplex({ method, headers, body: bodyBuf, signal }, bodyBuf))
        if (!isRelayFailureStatus(res.status)) return res
        lastError = new Error(`relay responded ${res.status}`)
        // Consume/cancel relay error body so the socket can be reused.
        try {
          await res.body?.cancel()
        } catch {
          // ignore
        }
      } catch (e) {
        if (signal.aborted) throw e
        lastError = e
      }
    }

    emit("relay fallback to direct", {
      target: url.origin,
      path: url.pathname,
      error: String(lastError),
    })
    return direct(url.href, withDuplex({ method, headers: originalHeaders, body: bodyBuf, signal }, bodyBuf))
  }
}

function parseOptions(options: Record<string, unknown> | undefined): {
  relays: string[]
  debug: boolean
} {
  const url = options?.["url"] as string | string[] | undefined
  const debugOpt = options?.["debug"] as boolean | undefined
  return {
    relays: normalizeRelays(url),
    debug: debugOpt ?? process.env.RELAY_DEBUG === "1",
  }
}

const PATCH_MARKER = "__opencodeRelayZenPatched"

export default Plugin.define({
  id: "relay",
  async setup(ctx) {
    const parsed = parseOptions(ctx.options as Record<string, unknown> | undefined)
    const debug = parsed.debug
    const prefix = "[relay]"
    // console output from v2 plugins is not forwarded to opencode logs,
    // so when debug is on, mirror everything to a file in /tmp as well.
    // Async fire-and-forget: logging never breaks requests.
    let warnedLogFile = false
    const fileLog: Logger | undefined = debug
      ? (message, extra) => {
          const line =
            `${new Date().toISOString()} ${prefix} ${message}` +
            (extra ? ` ${JSON.stringify(extra)}` : "") +
            "\n"
          appendFile(DEBUG_LOG, line).catch((e: unknown) => {
            if (!warnedLogFile) {
              warnedLogFile = true
              console.log(prefix, "debug log write failed", DEBUG_LOG, String(e))
            }
          })
        }
      : undefined
    const emit: Logger = (message, extra) => {
      console.log(prefix, message, extra ? JSON.stringify(extra) : "")
      fileLog?.(message, extra)
    }
    const log: Logger = (message, extra) => {
      if (debug) emit(message, extra)
    }

    // Validate early: an invalid relay URL would otherwise throw inside the
    // http.request hook and fail every model request with no fallback.
    const relays: string[] = []
    for (const candidate of parsed.relays) {
      try {
        const url = new URL(candidate)
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error(`unsupported protocol ${url.protocol}`)
        }
        relays.push(candidate)
      } catch (e) {
        emit("ignoring invalid relay url", { url: candidate, error: String(e) })
      }
    }

    emit("init", { debug, relayCount: relays.length })

    if (relays.length === 0) {
      emit("disabled: no relays configured (set plugin option `url` or RELAY_URL)", {})
      return
    }

    log("relay pool loaded", { relays })

    const rawFetch = globalThis.fetch
    const g = globalThis as Record<string, unknown>
    const previousFetch: typeof fetch | undefined =
      typeof g[PATCH_MARKER] === "function" ? (g[PATCH_MARKER] as typeof fetch) : undefined
    const originalForPatch = previousFetch ?? rawFetch
    // Bind the pristine fetch, not a possibly already-patched one from a
    // prior setup without cleanup (avoids wrapping the patch recursively).
    const directFetch = originalForPatch.bind(globalThis)
    const pickIndex = createRoundRobin(relays.length)
    const relayOrigins = buildRelayOrigins(relays)
    const relayFetch = createRelayFetch(relays, pickIndex, directFetch, debug, log, emit)

    // --- Global fetch patch for out-of-session Zen traffic (v1 parity) ---
    // Session model traffic is covered by hooks below; this covers anything
    // else that calls fetch("https://opencode.ai/zen/...") directly.
    if (!g[PATCH_MARKER]) {
      g[PATCH_MARKER] = originalForPatch
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (typeof urlStr === "string" && urlStr.startsWith(ZEN_PREFIX)) {
          try {
            if (!relayOrigins.has(new URL(urlStr).origin)) return relayFetch(input, init)
          } catch {
            // fall through to direct fetch
          }
        }
        return (originalForPatch as typeof fetch)(input as Parameters<typeof fetch>[0], init)
      }) as typeof fetch
    }

    // Shared state between hooks.
    const pendingBodies = new WeakMap<Request, { body?: ArrayBuffer; start: number }>()
    // Sessions whose next attempt must go direct (relay pool exhausted).
    // Keyed per session so concurrent sessions don't steal each other's flag.
    // Entries are consumed by the next http.request of that session; a stale
    // entry only causes a single direct request and is then removed.
    const forceDirectSessions = new Set<string>()
    const disposables: Array<{ dispose?: () => unknown | Promise<unknown> }> = []
    // Backoff for forced retries: grow with the attempt count so a 429 from
    // the whole pool doesn't hammer the relays on immediate retry.
    const retryDelay = (attempt: number) => Math.min(2000, 250 * attempt)

    function isRelayedRequest(req: Request): boolean {
      return req.headers.has("x-relay-target") || relayOrigins.has(safeOrigin(req.url))
    }

    function safeOrigin(href: string): string {
      try {
        return new URL(href).origin
      } catch {
        return href
      }
    }

    function originalFromRelayed(req: Request): { origin: string; path: string } | undefined {
      const target = req.headers.get("x-relay-target")
      const path = req.headers.get("x-relay-path")
      if (target && path) return { origin: target, path }
      return undefined
    }

    // --- Rewrite every session HTTP request to go via a relay ---
    disposables.push(
      await ctx.session.hook("http.request", async (event) => {
      if (forceDirectSessions.has(event.sessionID)) {
        forceDirectSessions.delete(event.sessionID)
        log("direct fallback (all relays failed previously)", { url: event.request.url })
        return
      }
      let url: URL
      try {
        url = new URL(event.request.url)
      } catch {
        return
      }
      // Avoid relaying the relay itself (loop).
      if (relayOrigins.has(url.origin)) return

      // Scope: only the Zen endpoint goes through the relay. Other
      // providers already point at direct gateways and are left untouched.
      if (!url.href.startsWith(ZEN_PREFIX)) return

      // Buffer body (streams are one-shot).
      let bodyBuf: ArrayBuffer | undefined
      try {
        if (event.request.body) bodyBuf = await event.request.arrayBuffer()
      } catch (e) {
        log("body buffer failed, sending direct", { error: String(e), url: url.href })
        return
      }

      const start = pickIndex()
      const relay = relays[start]
      const headers = new Headers(event.request.headers)
      headers.set("x-relay-target", url.origin)
      headers.set("x-relay-path", relayPath(url))
      log(`${event.request.method} ${url.origin}${url.pathname}`, { relay })

      const rewritten = new Request(relay, withDuplex({ method: event.request.method, headers, body: bodyBuf }, bodyBuf))
      pendingBodies.set(rewritten, { body: bodyBuf, start })
      event.request = rewritten
      }),
    )

    // --- Failover: if the relay answered 429/5xx, try remaining relays + direct ---
    // Mirrors the v1 for-loop, but executed here because v2 hooks edit the
    // Request/Response instead of wrapping fetch.
    disposables.push(
      await ctx.session.hook("http.response", async (event) => {
      if (!isRelayedRequest(event.request)) return
      if (!isRelayFailureStatus(event.response.status)) return

      const orig = originalFromRelayed(event.request)
      if (!orig) return
      const headers = new Headers(event.request.headers)
      headers.delete("x-relay-target")
      headers.delete("x-relay-path")
      const method = event.request.method
      const signal = event.request.signal
      const pending = pendingBodies.get(event.request)
      let bodyBuf = pending?.body
      // Deterministic order: continue from the relay tried in http.request,
      // so each pool member is tried exactly once even under concurrency.
      const start = pending?.start ?? 0
      if (!pending) {
        // Another plugin rewrote the request after us: the buffered body is
        // gone, try reading the (possibly already-consumed) stream.
        if (event.request.body) {
          try {
            bodyBuf = await event.request.arrayBuffer()
          } catch {
            bodyBuf = undefined
          }
        }
        log("relay context missing, failover may resend without body", { method })
      }
      try {
        await event.response.body?.cancel()
      } catch {
        // ignore
      }

      if (await failoverToDirect(event, relays, start, orig, method, headers, bodyBuf, signal, directFetch, log, emit)) return
      }),
    )

    // --- Retry: relay network errors never produce http.response, so force a retry ---
    // The next attempt's http.request picks the next relay (round-robin).
    // When attempts are exhausted, flag the next attempt to go direct.
    disposables.push(
      await ctx.session.hook("retry", (event) => {
      // Only Zen requests are relayed; leave other providers' retry policy alone.
      if (event.model.providerID !== "opencode") return
      const status = event.error.status
      const retryable = status === undefined || status === 429 || status >= 500
      if (!retryable) return
      if (event.attempt <= relays.length) {
        if (!event.decision.retry) {
          log("forcing retry for relay failover", { attempt: event.attempt, status })
          event.decision = { retry: true, delay: retryDelay(event.attempt) }
        }
        return
      }
      if (event.attempt === relays.length + 1) {
        log("all relays failed, next attempt goes direct", { attempt: event.attempt })
        forceDirectSessions.add(event.sessionID)
        if (!event.decision.retry) event.decision = { retry: true, delay: retryDelay(event.attempt) }
      }
      }),
    )

    // WebSocket routes bypass the HTTP relay protocol (v1 only patched fetch).
    // Keep them direct so streaming providers don't break; log in debug mode.
    disposables.push(
      await ctx.session.hook("experimental.ws.handshake", (event) => {
        log("ws.handshake direct (relay is HTTP-only)", { url: event.url })
      }),
    )

    // Light-touch provider touch: ensure the built-in opencode (Zen) provider
    // stays enabled so Zen traffic exists for the hooks/patch above to relay.
    // No baseURL/fetch override here — v2 providers don't expose fetch;
    // routing happens in the session hooks.
    try {
      disposables.push(
        await ctx.provider.transform((editor) => {
          const record = editor.get("opencode")
          if (!record) return
          if (record.provider.activation === "disabled") {
            editor.update("opencode", (provider) => {
              provider.activation = "enabled"
            })
          }
        }),
      )
    } catch (e) {
      log("provider transform skipped", { error: String(e) })
    }

    return async () => {
      for (const d of disposables.splice(0)) {
        try {
          await d.dispose?.()
        } catch {
          // ignore
        }
      }
      if (!g[PATCH_MARKER]) return
      try {
        globalThis.fetch = (g[PATCH_MARKER] as typeof fetch) ?? directFetch
      } catch {
        // ignore
      }
      delete g[PATCH_MARKER]
    }
  },
})
