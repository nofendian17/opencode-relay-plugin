import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import { readFile, rm } from "node:fs/promises"
import plugin from "../index.ts"

const MARKER = "__opencodeRelayZenPatched"

let realFetch: typeof fetch

beforeEach(() => {
  realFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete (globalThis as Record<string, unknown>)[MARKER]
  delete process.env.RELAY_URL
})

function mockCtx(options: Record<string, unknown>) {
  const hooks: Record<string, (...args: never[]) => unknown> = {}
  const ctx = {
    options,
    session: {
      hook: async (name: string, cb: (...args: never[]) => unknown) => {
        hooks[name] = cb
        return { dispose: async () => {} }
      },
    },
    provider: {
      transform: async () => ({ dispose: async () => {} }),
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ctx: ctx as any, hooks }
}

async function cleanupOf(value: unknown) {
  if (typeof value === "function") await (value as () => unknown)()
}

describe("relay plugin (v2)", () => {
  it("exposes id + setup", () => {
    assert.equal((plugin as { id: string }).id, "relay")
    assert.equal(typeof (plugin as { setup: unknown }).setup, "function")
  })

  it("ignores invalid relay urls and uses the valid ones", async () => {
    const { ctx, hooks } = mockCtx({ url: ["not-a-url", "ftp://x/r", "https://r1.example.com/"] })
    const done = await (plugin as unknown as { setup: (c: unknown) => unknown }).setup(ctx)
    try {
      const ev = {
        sessionID: "s1",
        request: new Request("https://opencode.ai/zen/v1", { method: "GET" }),
      }
      await (hooks["http.request"] as (e: unknown) => Promise<void>)(ev)
      assert.ok(
        (ev.request as Request).url.replace(/\/$/, "") === "https://r1.example.com",
        `uses the valid relay, got ${(ev.request as Request).url}`,
      )
    } finally {
      await cleanupOf(done)
    }
  })

  it("disables itself when no relay is valid", async () => {
    const { ctx, hooks } = mockCtx({ url: ["not-a-url"] })
    const done = await (plugin as unknown as { setup: (c: unknown) => unknown }).setup(ctx)
    assert.equal(Object.keys(hooks).length, 0)
    assert.equal(done, undefined)
  })

  it("round-robins across the relay pool", async () => {
    const { ctx, hooks } = mockCtx({ url: ["https://r1.x", "https://r2.x"] })
    const done = await (plugin as unknown as { setup: (c: unknown) => unknown }).setup(ctx)
    try {
      const urls: string[] = []
      for (let i = 0; i < 4; i++) {
        const ev = {
          sessionID: "s1",
          request: new Request("https://opencode.ai/zen/v1", { method: "GET" }),
        }
        await (hooks["http.request"] as (e: unknown) => Promise<void>)(ev)
        urls.push((ev.request as Request).url.replace(/\/$/, ""))
      }
      assert.deepEqual(urls, ["https://r1.x", "https://r2.x", "https://r1.x", "https://r2.x"])
    } finally {
      await cleanupOf(done)
    }
  })

  it("sets x-relay-target and x-relay-path, preserving method and body", async () => {
    const { ctx, hooks } = mockCtx({ url: "https://r1.x" })
    const done = await (plugin as unknown as { setup: (c: unknown) => unknown }).setup(ctx)
    try {
      const ev = {
        sessionID: "s1",
        request: new Request("https://opencode.ai/zen/v1/messages?x=1", {
          method: "POST",
          headers: { "x-api-key": "k" },
          body: '{"a":1}',
        }),
      }
      await (hooks["http.request"] as (e: unknown) => Promise<void>)(ev)
      const req = ev.request as Request
      assert.equal(req.headers.get("x-relay-target"), "https://opencode.ai")
      assert.equal(req.headers.get("x-relay-path"), "/zen/v1/messages?x=1")
      assert.equal(req.headers.get("x-api-key"), "k")
      assert.equal(req.method, "POST")
      assert.equal(await req.text(), '{"a":1}')
    } finally {
      await cleanupOf(done)
    }
  })

  it("fails over through remaining relays then direct, in order", async () => {
    const tried: string[] = []
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url
      tried.push(url.replace(/\/$/, ""))
      if (url.startsWith("https://r")) return new Response("err", { status: 500 })
      return new Response("direct-ok", { status: 200 })
    }) as typeof fetch

    const { ctx, hooks } = mockCtx({ url: ["https://r1.x", "https://r2.x", "https://r3.x"] })
    const done = await (plugin as unknown as { setup: (c: unknown) => unknown }).setup(ctx)
    try {
      const ev = {
        sessionID: "s1",
        request: new Request("https://opencode.ai/zen/v1", { method: "GET" }),
      }
      await (hooks["http.request"] as (e: unknown) => Promise<void>)(ev)
      assert.ok((ev.request as Request).url.startsWith("https://r1.x"))
      const resEv = {
        sessionID: "s1",
        request: ev.request,
        response: new Response("e", { status: 500 }),
      }
      await (hooks["http.response"] as (e: unknown) => Promise<void>)(resEv)
      assert.deepEqual(tried, ["https://r2.x", "https://r3.x", "https://opencode.ai/zen/v1"])
      assert.equal((resEv.response as Response).status, 200)
      assert.equal(await (resEv.response as Response).text(), "direct-ok")
    } finally {
      await cleanupOf(done)
    }
  })

  it("leaves non-Zen providers untouched", async () => {
    const { ctx, hooks } = mockCtx({ url: ["https://r1.x"] })
    const done = await (plugin as unknown as { setup: (c: unknown) => unknown }).setup(ctx)
    try {
      const original = new Request("https://gateway.example.com/v1/chat/completions", {
        method: "POST",
        body: "{}",
      })
      const ev = { sessionID: "s1", request: original }
      await (hooks["http.request"] as (e: unknown) => Promise<void>)(ev)
      assert.equal(ev.request, original)
      assert.ok(!(ev.request as Request).headers.has("x-relay-target"))
    } finally {
      await cleanupOf(done)
    }
  })

  it("leaves successful relay responses untouched", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("x", { status: 200 })
    }) as typeof fetch

    const { ctx, hooks } = mockCtx({ url: ["https://r1.x"] })
    const done = await (plugin as unknown as { setup: (c: unknown) => unknown }).setup(ctx)
    try {
      const ev = {
        sessionID: "s1",
        request: new Request("https://opencode.ai/zen/v1", { method: "GET" }),
      }
      await (hooks["http.request"] as (e: unknown) => Promise<void>)(ev)
      const original = new Response("ok", { status: 200 })
      const resEv = { sessionID: "s1", request: ev.request, response: original }
      await (hooks["http.response"] as (e: unknown) => Promise<void>)(resEv)
      assert.equal(resEv.response, original)
      assert.equal(calls, 0)
    } finally {
      await cleanupOf(done)
    }
  })

  it("forces retry on retryable relay failures but not on 400", async () => {
    const { ctx, hooks } = mockCtx({ url: ["https://r1.x", "https://r2.x"] })
    const done = await (plugin as unknown as { setup: (c: unknown) => unknown }).setup(ctx)
    try {
      const retry = hooks["retry"] as (e: {
        model: { providerID: string }
        error: { status?: number }
        attempt: number
        decision: { retry: boolean; delay?: number }
      }) => void
      const zen = { providerID: "opencode" }
      const e500 = { model: zen, error: { status: 500 }, attempt: 1, decision: { retry: false } }
      retry(e500)
      assert.equal(e500.decision.retry, true)
      const e400 = { model: zen, error: { status: 400 }, attempt: 1, decision: { retry: false } }
      retry(e400)
      assert.equal(e400.decision.retry, false)
      const other = {
        model: { providerID: "other" },
        error: { status: 500 },
        attempt: 1,
        decision: { retry: false },
      }
      retry(other)
      assert.equal(other.decision.retry, false)
    } finally {
      await cleanupOf(done)
    }
  })

  it("sends only the exhausted session direct", async () => {
    const { ctx, hooks } = mockCtx({ url: ["https://r1.x", "https://r2.x"] })
    const done = await (plugin as unknown as { setup: (c: unknown) => unknown }).setup(ctx)
    try {
      const retry = hooks["retry"] as (e: {
        sessionID: string
        model: { providerID: string }
        error: { status?: number }
        attempt: number
        decision: { retry: boolean; delay?: number }
      }) => void
      retry({
        sessionID: "sA",
        model: { providerID: "opencode" },
        error: { status: 500 },
        attempt: 3,
        decision: { retry: false },
      })

      const evA = { sessionID: "sA", request: new Request("https://opencode.ai/zen/v1") }
      await (hooks["http.request"] as (e: unknown) => Promise<void>)(evA)
      assert.equal((evA.request as Request).url, "https://opencode.ai/zen/v1")

      const evB = { sessionID: "sB", request: new Request("https://opencode.ai/zen/v1") }
      await (hooks["http.request"] as (e: unknown) => Promise<void>)(evB)
      assert.ok((evB.request as Request).url.startsWith("https://r"))

      // Flag is consumed: the next sA request goes via relay again.
      const evA2 = { sessionID: "sA", request: new Request("https://opencode.ai/zen/v1") }
      await (hooks["http.request"] as (e: unknown) => Promise<void>)(evA2)
      assert.ok((evA2.request as Request).url.startsWith("https://r"))
    } finally {
      await cleanupOf(done)
    }
  })

  it("restores global fetch on cleanup", async () => {
    const { ctx } = mockCtx({ url: ["https://r1.x"] })
    const before = globalThis.fetch
    const done = await (plugin as unknown as { setup: (c: unknown) => unknown }).setup(ctx)
    assert.notEqual(globalThis.fetch, before)
    await cleanupOf(done)
    assert.equal(globalThis.fetch, before)
    assert.equal((globalThis as Record<string, unknown>)[MARKER], undefined)
  })

  it("patches global fetch for out-of-session Zen traffic", async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url
      calls.push(url)
      return new Response("ok", { status: 200 })
    }) as typeof fetch

    const { ctx } = mockCtx({ url: ["https://r1.x"] })
    const done = await (plugin as unknown as { setup: (c: unknown) => unknown }).setup(ctx)
    try {
      const res = await globalThis.fetch("https://opencode.ai/zen/v1/messages")
      assert.equal(res.status, 200)
      assert.ok(calls.some((u) => u.startsWith("https://r1.x")), `relay got the call, got ${JSON.stringify(calls)}`)
      assert.ok(!calls.some((u) => u.startsWith("https://opencode.ai")), "direct URL not called")
    } finally {
      await cleanupOf(done)
    }
  })

  it("does not patch global fetch for non-Zen traffic", async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url
      calls.push(url)
      return new Response("ok", { status: 200 })
    }) as typeof fetch

    const { ctx } = mockCtx({ url: ["https://r1.x"] })
    const done = await (plugin as unknown as { setup: (c: unknown) => unknown }).setup(ctx)
    try {
      const res = await globalThis.fetch("https://api.anthropic.com/v1/messages")
      assert.equal(res.status, 200)
      assert.ok(calls.some((u) => u.startsWith("https://api.anthropic.com")), "direct URL got the call")
      assert.ok(!calls.some((u) => u.startsWith("https://r1.x")), "relay not called")
    } finally {
      await cleanupOf(done)
    }
  })

  it("writes debug log to /tmp when debug is true", async () => {
    const file = "/tmp/opencode-relay.log"
    await rm(file, { force: true })
    try {
      const { ctx } = mockCtx({ url: ["https://r1.x"], debug: true })
      const done = await (plugin as unknown as { setup: (c: unknown) => unknown }).setup(ctx)
      try {
        let content = ""
        for (let i = 0; i < 50; i++) {
          try {
            content = await readFile(file, "utf8")
            if (content.includes("[relay] init")) break
          } catch {
            // not flushed yet
          }
          await new Promise((r) => setTimeout(r, 20))
        }
        assert.ok(content.includes("[relay] init"), "init line written to /tmp")
      } finally {
        await cleanupOf(done)
      }
    } finally {
      await rm(file, { force: true })
    }
  })

  it("writes no file when debug is false", async () => {
    const file = "/tmp/opencode-relay.log"
    await rm(file, { force: true })
    const { ctx } = mockCtx({ url: ["https://r1.x"] })
    const done = await (plugin as unknown as { setup: (c: unknown) => unknown }).setup(ctx)
    try {
      await new Promise((r) => setTimeout(r, 100))
      const exists = await readFile(file, "utf8")
        .then(() => true)
        .catch(() => false)
      assert.equal(exists, false)
    } finally {
      await cleanupOf(done)
    }
  })
})
