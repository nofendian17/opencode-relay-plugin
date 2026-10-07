# opencode-relay-plugin (v2)

Route OpenCode **v2** Zen traffic (`https://opencode.ai/zen/*`) through your
relay endpoint(s), ported from the v1 `relay.js`
(`@opencode-ai/plugin` → `@opencode/plugin`).

Only Zen requests are relayed; other providers already point at direct
gateways and are left untouched (no rewrite, no forced retries).

V1 patched `provider.options.fetch` + `globalThis.fetch`. V2 providers no longer expose `fetch`,
so this plugin uses the documented v2 interception points:

- `ctx.session.hook("http.request")` — rewrite provider HTTP → `POST <relay>` with
  `x-relay-target: <origin>` + `x-relay-path: <path+query>` (round-robin)
- `ctx.session.hook("http.response")` — on relay `429 / 5xx`, try remaining relays, then direct
- `ctx.session.hook("retry")` — relay network errors never reach `http.response`, so force a
  retry (next attempt picks the next relay); after the pool is exhausted the next attempt goes direct
- `ctx.session.hook("experimental.ws.handshake")` — no-op (relay is HTTP-only, kept direct)
- `globalThis.fetch` patch — only for out-of-session `https://opencode.ai/zen/*` traffic (v1 parity)
- `ctx.provider.transform` — re-enable the built-in `opencode` (Zen) provider if disabled

Reference: https://opencode.ai/v2/docs/plugins/ + migration guide
`https://opencode.ai/v2/docs/build/plugins/migrate-v1/`.

## Install

```sh
# inside your project
npm i opencode-relay-plugin
# or local path
```

## Configure

`opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-relay-plugin",
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
| `debug: boolean` | `RELAY_DEBUG=1` | Verbose per-request logging. When on, log lines are also appended to `/tmp/opencode-relay.log` (plugin `console.log` is not forwarded to opencode logs). |

## Relay protocol (unchanged from v1)

- `<relay-url>` with original method/body/headers plus:
  - `x-relay-target: https://api.anthropic.com` (origin)
  - `x-relay-path: /v1/messages?foo=bar` (path + query)
- Relay returns the provider response verbatim (status/body/headers).
- `429` or `>= 500` → try next relay → fall back to direct.
- Network error → try next relay → fall back to direct.

## Security

The relay terminates TLS and sees everything it forwards: request bodies and
all headers, including provider credentials (`Authorization`, `x-api-key`, …).
Only use relays you operate or fully trust, always over HTTPS, and treat relay
access logs as secret-bearing.

## Verify

1. `RELAY_DEBUG=1` + set `url` to a local echo server, run a prompt, confirm
   `x-relay-target` / `x-relay-path` headers arrive.
2. Stop the relay → request still succeeds via direct fallback (check `[relay] fallback to direct` log).
3. Unset `url`/`RELAY_URL` → `[relay] disabled` log, traffic goes direct.

## V1 vs V2 notes

| V1 (`@opencode-ai/plugin`) | V2 (`@opencode/plugin`) |
| --- | --- |
| `export default async (ctx, opts) => ({ config })` | `Plugin.define({ id: "relay", setup(ctx) })` |
| `config.provider[].options.fetch = relayFetch` | `session.hook("http.request"/"http.response")` |
| `config.provider["opencode"] = { baseURL: ZEN }` | built-in provider + `provider.transform` (enable-only) |
| `ctx.client.app.log(...)` | `console.log("[relay]", ...)` (no log API in v2 ctx) |
| plugin options argument | `ctx.options` |
| returned `{ config }` | registrations disposed on unload + `setup` cleanup restores `fetch` |
