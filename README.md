# @nofendian17/opencode-relay-plugin (v2)

Route OpenCode **v2** opencode.ai traffic through your relay endpoint(s),
ported from the v1 `relay.js` (`@opencode-ai/plugin` → `@opencode/plugin`).

## Scope

Matched by **origin** (`https://opencode.ai`), not by path prefix. This covers
`/zen/*`, `/inference/*`, and any future path on the same origin. (Before
v2.0.4 the match was prefix-based on `/zen/*`, so `/inference/*` traffic
silently went direct — same rate-limit symptom, no relay in the log.)

Only opencode.ai requests are relayed; other providers already point at direct
gateways and are left untouched (no rewrite, no forced retries).

V1 patched `provider.options.fetch` + `globalThis.fetch`. V2 providers no longer expose `fetch`,
so this plugin uses the documented v2 interception points:

- `ctx.session.hook("http.request")` — rewrite provider HTTP → `<relay>` (original method/body/headers preserved) with
  `x-relay-target: <origin>` + `x-relay-path: <path+query>` (round-robin)
- `ctx.session.hook("http.response")` — on relay `429 / 5xx`, try remaining relays, then direct
- `ctx.session.hook("retry")` — relay network errors never reach `http.response`, so force a
  retry (next attempt picks the next relay); after the pool is exhausted the next attempt goes direct
- `ctx.session.hook("experimental.ws.handshake")` — no-op (relay is HTTP-only, kept direct)
- `globalThis.fetch` patch — only for out-of-session `https://opencode.ai/*` traffic (v1 parity)
- `ctx.provider.transform` — re-enable the built-in `opencode` (Zen) provider if disabled

Reference: https://opencode.ai/v2/docs/plugins/ + migration guide
`https://opencode.ai/v2/docs/build/plugins/migrate-v1/`.

## Install

```sh
# inside your project
npm i @nofendian17/opencode-relay-plugin
# or local path
```

## Configure

`opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@nofendian17/opencode-relay-plugin",
      "options": {
        "url": "https://relay.example.com/relay",
        // "url": ["https://r1.example.com", "https://r2.example.com"],
        // "debug": true,
      },
    },
  ],
}
```

Local file (auto-discovered):

```text
.opencode/plugins/relay/index.ts  -> copy index.ts here
```

| Option | Env fallback | Description |
| --- | --- | --- |
| `url: string \| string[]` | `RELAY_URL` (comma-separated) | Relay endpoint(s), `http(s)` only. Invalid entries are skipped with a warning log; if none remain valid the plugin disables itself. |
| `debug: boolean` | `RELAY_DEBUG=1` | Verbose per-request logging. **Ini opsi plugin** (`plugins[].options.debug`), **bukan** top-level `debug` di `opencode.jsonc` — top-level `debug` tidak mengaktifkan log plugin ini. Baris penting (`init`, `disabled`, `fallback`) selalu ditulis ke file log; baris verbose per-request hanya saat `debug` on. Override path dengan `RELAY_DEBUG_LOG` (dipakai tests untuk isolasi). |

## Relay protocol (unchanged from v1)

- `<relay-url>` with original method/body/headers plus:
  - `x-relay-target: https://opencode.ai` (origin)
  - `x-relay-path: /inference/v1/chat/completions` (path + query)
- Relay returns the provider response verbatim (status/body/headers).
- `429` or `>= 500` → try next relay → fall back to direct.
- Network error → try next relay → fall back to direct.

Retry accounting: attempts `1..N` (pool size) each try the next relay in
round-robin order; attempt `N+1` goes direct once (per-session flag, consumed
by the next `http.request`), then the pool is used again.

## Security

The relay terminates TLS and sees everything it forwards: request bodies and
all headers, including provider credentials (`Authorization`, `x-api-key`, …).
Only use relays you operate or fully trust, always over HTTPS, and treat relay
access logs as secret-bearing.

## Verify

1. Set plugin option `debug: true` + `url` ke local echo server, run prompt, confirm
   `x-relay-target` / `x-relay-path` headers arrive.
2. Stop the relay → request still succeeds via direct fallback (check
   `[relay] relay fallback to direct` in the log file — path is printed in the
   `[relay] init` line as `logFile`).
3. Unset `url`/`RELAY_URL` → `[relay] disabled` log, traffic goes direct.
4. Confirm scope: a request to `https://opencode.ai/inference/...` must show
   `via relay` in the log. If the log only shows
   `direct fallback (all relays failed previously)` with an
   `https://opencode.ai/...` URL and zero `via relay` lines, the request never
   entered the pool — check the origin match in `index.ts`.

Note: the default file is `os.tmpdir()/opencode-relay.log` — on macOS that is
`$TMPDIR/opencode-relay.log` (e.g. `/var/folders/.../T/`), NOT `/tmp/`.
Check the `logFile` field in the `[relay] init` line for the exact path.
Concurrent opencode processes append to the same file. Plugin `console.log`
is not forwarded to opencode logs, so always check the file, not the TUI.

## V1 vs V2 notes

| V1 (`@opencode-ai/plugin`) | V2 (`@opencode/plugin`) |
| --- | --- |
| `export default async (ctx, opts) => ({ config })` | `Plugin.define({ id: "relay", setup(ctx) })` |
| `config.provider[].options.fetch = relayFetch` | `session.hook("http.request"/"http.response")` |
| `config.provider["opencode"] = { baseURL: ZEN }` | built-in provider + `provider.transform` (enable-only) |
| `ctx.client.app.log(...)` | `console.log("[relay]", ...)` (no log API in v2 ctx) |
| plugin options argument | `ctx.options` |
| returned `{ config }` | registrations disposed on unload + `setup` cleanup restores `fetch` |
