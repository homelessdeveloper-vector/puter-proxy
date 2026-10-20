# puter-proxy

A self-hosted Express gateway that wraps Puter's cloud capabilities behind a
single authenticated JSON endpoint. Clients send one `POST /v1/execute` with an
`X-API-Key`; the server holds the Puter credentials, rotates them across a pool
of accounts, and translates every outcome — success or failure — into the same
JSON envelope.

```
client ──X-API-Key──▶ puter-proxy ──account pool──▶ api.puter.com
                          │
                          └─ per-account egress: direct │ SOCKS5/Tor
```

## Contents

- [Quick start](#quick-start)
- [Installing on a server](#installing-on-a-server)
- [Configuration](#configuration)
- [The API](#the-api)
- [Operations](#operations)
- [Multiple accounts](#multiple-accounts)
- [Tor and per-account egress](#tor-and-per-account-egress)
- [Loading accounts from GitHub](#loading-accounts-from-github)
- [Error handling](#error-handling)
- [Security model](#security-model)
- [Operations tooling](#operations-tooling)
- [Tests](#tests)

---

## Quick start

```bash
npm install
cp .env.example .env
```

Generate a client key and put its **hash** in `.env`:

```bash
KEY=$(openssl rand -hex 32)
printf '%s' "$KEY" | shasum -a 256 | cut -d' ' -f1
echo "your key: $KEY"          # send this to clients
```

```dotenv
API_KEYS=local:sha256:<the-hex-above>
PUTER_AUTH_TOKEN=<your puter token>
```

```bash
npm start
```

```bash
curl -s http://127.0.0.1:8080/v1/execute \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KEY" \
  -d '{
    "operation": "chat",
    "input": { "messages": [ { "role": "user", "content": "Hello" } ] }
  }'
```

```json
{
  "ok": true,
  "request_id": "6f2fd092-ffb7-4339-a239-9c28fc7cd099",
  "operation": "chat",
  "account": { "id": "primary", "label": "PUTER_AUTH_TOKEN" },
  "data": {
    "operation": "chat",
    "model": "gpt-5.1",
    "content": "...",
    "role": "assistant",
    "usage": { "prompt_tokens": 3, "completion_tokens": 7, "total_tokens": 10 },
    "finish_reason": null,
    "latency_ms": 31
  },
  "meta": { "duration_ms": 68, "attempts": 1, "via_proxy": null }
}
```

> Run with no `API_KEYS` in development and the server generates a throwaway key,
> printing it to stderr once at boot. It refuses to start without keys when
> `NODE_ENV=production`.

---

## Installing on a server

### 1. Prerequisites

- **Node.js 20 or newer** — `node --version`
- **Tor** if you want the tunnel (see [Tor and per-account egress](#tor-and-per-account-egress))

```bash
# macOS
brew install node tor

# Debian / Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs tor
```

### 2. Clone and install

```bash
git clone https://github.com/homelessdeveloper-vector/puter-proxy.git
cd puter-proxy
npm ci --omit=dev
```

### 3. Configure

```bash
cp .env.example .env
chmod 600 .env
```

Generate two keys — one for clients, one for you:

```bash
for name in client admin; do
  KEY=$(openssl rand -hex 32)
  HASH=$(printf '%s' "$KEY" | shasum -a 256 | cut -d' ' -f1)
  echo "$name key:  $KEY"
  echo "$name hash: $HASH"
done
```

Put the **hashes** in `.env` — never the keys themselves:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=8080

API_KEYS=client:sha256:<client-hash>|execute,admin:sha256:<admin-hash>|execute+admin

PUTER_AUTH_TOKEN=<your puter token>

# Route everything through Tor
PUTER_PROXY=tor
```

> The `sha256:` prefix is mandatory. `openssl rand -hex 32` and a SHA-256 digest
> are both exactly 64 hex characters, so a missing prefix looks valid and fails
> silently at request time. The server logs each key's mode at boot
> (`api_keys:["client(sha256)","admin(sha256)"]`) so you can confirm.

### 4. Run it under a supervisor

A foreground `npm start` dies with your shell. Use systemd:

```ini
# /etc/systemd/system/puter-proxy.service
[Unit]
Description=puter-proxy
After=network-online.target tor.service
Wants=network-online.target

[Service]
Type=simple
User=puter
WorkingDirectory=/opt/puter-proxy
EnvironmentFile=/opt/puter-proxy/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now puter-proxy
sudo journalctl -u puter-proxy -f
```

On macOS, use `launchd` or `pm2 start src/index.js --name puter-proxy`.

### 5. Verify

```bash
curl -s http://127.0.0.1:8080/health
curl -s http://127.0.0.1:8080/v1/accounts -H "X-API-Key: <admin-key>"
curl -s http://127.0.0.1:8080/v1/accounts/primary/egress -H "X-API-Key: <admin-key>"
```

The last one should report `"is_tor": true` if Tor is wired correctly.

### 6. Expose it safely

Keep `HOST=127.0.0.1` and put a TLS terminator in front — Caddy is two lines:

```
proxy.yourdomain.com {
    reverse_proxy 127.0.0.1:8080
}
```

Then set `TRUST_PROXY=1` in `.env` so rate limiting keys off the real client IP
instead of the proxy's.

---

## Configuration

Everything is environment-driven; `.env` is loaded via `dotenv`.

### Server

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enables strict config checks |
| `PORT` | `8080` | Listen port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only behind a proxy |
| `TRUST_PROXY` | `0` | Set `1` behind nginx/Caddy so rate limits key off the real client |
| `LOG_LEVEL` | `debug` (`info` in prod) | `error` \| `warn` \| `info` \| `debug` |

### Client auth

`API_KEYS` is a comma-separated list. Each entry takes one of these forms:

```
name:secret                     raw key, hashed in memory at boot
name:sha256:<hex>               pre-hashed key (preferred in production)
name:secret|execute+admin       append scopes; default is "execute" only
```

| Scope | Grants |
| --- | --- |
| `execute` | `POST /v1/execute` |
| `admin` | `/v1/accounts/*`, account pinning, the `generic` operation |

Two details that are easy to get wrong:

- **Scopes are joined with `+`, not `,`.** A comma starts a *new key entry*.
  `ops:k|execute,admin` parses as key `ops` (execute) plus a key literally named
  `admin` — the parser was fixed to make this impossible, and a bare `admin`
  entry would now fail loudly rather than silently existing.
- **A 64-character hex string is ambiguous.** `openssl rand -hex 32` and a
  SHA-256 digest are both exactly 64 hex characters. Without the `sha256:`
  prefix the value is treated as a **raw** key, so clients must send that exact
  hex string. The server warns at boot when a key looks like a digest but has no
  prefix, and logs the resolved mode for every key.

### Upstream credentials

| Variable | Purpose |
| --- | --- |
| `PUTER_AUTH_TOKEN` | Single account. Simplest possible setup |
| `PUTER_ACCOUNTS` | Inline JSON manifest — good for containers and secret managers |
| `ACCOUNTS_FILE` | Path to a local JSON manifest (default `./accounts.json`) |
| `ACCOUNT_MANIFEST_REPO` | Comma-separated GitHub repo specs |
| `ACCOUNT_MANIFEST_TOKEN` | PAT for private repos (Contents: Read-only) |
| `ACCOUNT_MAX_ATTEMPTS` | Accounts tried per request before giving up (default `2`) |
| `ACCOUNT_FAILOVER_ON_429` | `1` to let a rate limit spill onto the next account |

### Puter behaviour and limits

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUTER_API_ORIGIN` | `https://api.puter.com` | Override for self-hosted Puter |
| `PUTER_NORMALIZE` | `1` | Force OpenAI-style response bodies |
| `PUTER_DEFAULT_MODEL` | `gpt-5.1` | Model when the request omits one |
| `PUTER_MAX_TOKENS_CAP` | `8192` | Upper bound on `max_tokens` |
| `BODY_LIMIT` | `1mb` | JSON body limit |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream deadline, surfaced as `504` |
| `RATE_LIMIT_PER_MINUTE` | `60` | Sustained per-key rate |
| `RATE_LIMIT_BURST` | `10` | Token-bucket burst |
| `CORS_ORIGINS` | *(empty)* | Exact-origin allowlist. Empty disables browser access |

---

## The API

### `POST /v1/execute`

```json
{
  "operation": "chat",
  "input": { "...": "operation-specific" },
  "account": "acct-123"
}
```

`account` is optional, **admin-only**, and pins the request to one identity
instead of letting the pool choose. Tenant keys cannot select which upstream
account their traffic is billed to.

Success is always `200` with `ok: true`. Failures use the status matching the
cause and `ok: false`.

### `GET /health`

Unauthenticated liveness. Returns only `{ ok, service, accounts, uptime_s }` —
no account identifiers, no tokens.

### Admin endpoints

All require an `admin`-scoped key.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/accounts` | Pool status, health, cooldowns |
| `POST` | `/v1/accounts/check` | Live credential probe against Puter |
| `POST` | `/v1/accounts/reload` | Re-read manifests (picks up repo changes) |
| `POST` | `/v1/accounts` | Add an account at runtime, persisted locally |
| `DELETE` | `/v1/accounts/:id` | Remove an account |
| `POST` | `/v1/accounts/:id/revive` | Clear a cooldown |
| `GET` | `/v1/accounts/:id/egress` | Prove the proxy routes, report exit identity |

Accounts are described with a `token_fingerprint` (12 hex chars of a SHA-256)
and never the token itself.

---

## Operations

| Operation | Scope | Input | Returns |
| --- | --- | --- | --- |
| `chat` | execute | `messages` (or `prompt`), `model`, `temperature`, `max_tokens`, `tools` | `content`, `role`, `model`, `usage`, `finish_reason` |
| `image` | execute | `prompt`, `model` | `url` |
| `speech` | execute | `text`, `voice`, `engine`, `model` | `url` |
| `transcribe` | execute | `audio_url` (or `url`), `model` | `text` |
| `ocr` | execute | `image_url` (or `url`) | `text` |
| `models` | execute | — | `models`, `count` |
| `kv:get` | execute | `key` | `value` |
| `kv:set` | execute | `key`, `value` | `ok` |
| `fs:list` | execute | `path` | `items` |
| `fs:write` | execute | `path`, `content` | `path`, `size` |
| `generic` | execute **+ admin** | `iface`, `method`, `args` | raw driver envelope |

`generic` is a raw driver call, but only against an allowlist:
`puter-chat-completion`, `puter-image-generation`, `puter-tts`,
`puter-speech2txt`, `puter-speech2speech`, `puter-ocr`,
`puter-video-generation`. Interfaces that can read or destroy account state
(`fs`, `kv`, `auth`, `ipc`, `ui`) are deliberately absent.

**Streaming is refused explicitly** with a `400` rather than silently returning
a non-streamed body.

### Examples

Image generation:

```bash
curl -s http://127.0.0.1:8080/v1/execute \
  -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"operation":"image","input":{"prompt":"a red bicycle, studio photo"}}'
```

Text to speech:

```bash
curl -s http://127.0.0.1:8080/v1/execute \
  -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"operation":"speech","input":{"text":"Ship it.","voice":"Joanna"}}'
```

List models:

```bash
curl -s http://127.0.0.1:8080/v1/execute \
  -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"operation":"models","input":{}}'
```

---

## Multiple accounts

Sources **compose**, and later sources override earlier ones by `id`:

```
PUTER_AUTH_TOKEN  →  PUTER_ACCOUNTS  →  ACCOUNTS_FILE  →  ACCOUNT_MANIFEST_REPO
```

A manifest is either `{ "accounts": [...] }`, a bare array, or a single
`{ "token": "..." }` object.

```json
{
  "accounts": [
    { "id": "acct-a", "token": "eyJhbGci...", "label": "primary" },
    { "id": "acct-b", "token": "eyJhbGci...", "proxy": "tor" },
    { "id": "acct-c", "tokenEnv": "PUTER_TOKEN_C", "proxy": "socks5h://10.0.0.5:1080" }
  ]
}
```

`tokenEnv` reads the token from another environment variable, so the manifest
itself can be committed while secrets stay in the environment.

**Selection** prefers the least busy account, ties broken round-robin, skipping
anything cooling down. **Failover** replays a request on another account when
the failure is the upstream's fault — `rate_limited`, `quota_exhausted`,
`timeout`, `unreachable`, `error`.

Two deliberate choices:

- **A `429` never spills by default.** Otherwise one caller hammering a single
  account would silently drain the whole pool. Opt in with
  `ACCOUNT_FAILOVER_ON_429=1`.
- **Client mistakes never damage account health.** A malformed prompt returns
  `400` without cooling anything down; only genuine upstream faults are charged
  to an account.

Cooldowns: rate limit 60 s (honouring `Retry-After`, capped at 30 min), quota
15 min, network 30 s, server 15 s, otherwise exponential capped at 2 min. A
`401`/`403` marks the account `dead` until explicitly revived.

---

## Tor and per-account egress

### Route everything through Tor

One line covers the common case. Any account that does not declare its own
proxy inherits this:

```dotenv
PUTER_PROXY=tor
```

Then every request the server makes to Puter — chat, images, TTS, all of it —
leaves through `127.0.0.1:9050`.

### How to actually run Tor

The proxy speaks SOCKS5; it does not ship an onion router. You need a Tor
daemon listening on 9050 before `PUTER_PROXY=tor` means anything.

**macOS (Homebrew):**

```bash
brew install tor
brew services start tor          # keeps it alive across reboots
```

**Debian / Ubuntu:**

```bash
sudo apt-get install -y tor
# /etc/tor/torrc already has "SocksPort 9050" by default
sudo systemctl enable --now tor
```

**Verify the daemon is up and actually exiting:**

```bash
curl -s --socks5-hostname 127.0.0.1:9050 https://check.torproject.org/api/ip
# {"IsTor":true,"IP":"185.x.x.x"}
```

Or let the bundled helper start it, find it, and prove it:

```bash
npm run tor:start     # starts if needed, then verifies the exit is really Tor
```

If `IsTor` is `true`, the daemon and the circuit are both fine. If that command
hangs, Tor has not finished bootstrapping — check
`journalctl -u tor -n 20` (Linux) or `~/Library/Logs/homebrew/services/tor.log`
(macOS) for a `Bootstrapped 100%` line.

> **`--socks5-hostname`, not `--socks5`.** The latter resolves DNS locally and
> leaks the hostname to your resolver. The server always does the `h` form.

### Running Tor without installing it

If a package manager is unavailable, `scripts/start-tor.sh` falls back to the
daemon bundled with Tor Browser:

```bash
npm run tor:start
```

It starts the daemon detached (so it survives the calling shell), waits for
bootstrap, and confirms the exit IP is Tor. Run it under a real supervisor —
`brew services`, `systemd`, `launchd` — for anything long-lived. A daemon
started from an interactive shell dies with the shell, which shows up as every
request failing over and the pool draining.

### Per-account egress

Egress is decided per account, so one process can mix Tor and direct traffic.
An account-level `proxy` overrides `PUTER_PROXY`; an explicit `null` opts out.

```json
{ "id": "acct-b", "token": "...", "proxy": "tor" },
{ "id": "acct-c", "token": "...", "proxy": null }
```

| `proxy` value | Resolves to |
| --- | --- |
| `tor` | `socks5h://127.0.0.1:9050` |
| `9051` | `socks5h://127.0.0.1:9051` |
| `host:port` | `socks5h://host:port` |
| `host` | `socks5h://host:9050` |
| `http://…`, `https://…`, `socks5h://…` | used as-is |

`socks5h` means DNS resolves **at the proxy**, so a Tor exit node sees the
hostname rather than your resolver leaking it. undici does not accept the
`socks5h` scheme, so it is mapped to `socks5` internally while keeping
hostname forwarding.

Verify a route end to end:

```bash
curl -s http://127.0.0.1:8080/v1/accounts/acct-b/egress \
  -H "X-API-Key: $ADMIN_KEY"
```

```json
{
  "ok": true,
  "account": "acct-b",
  "proxy": "tor",
  "reachable": true,
  "duration_ms": 1739,
  "exit": { "checked": true, "is_tor": true, "exit_ip": "45.66.35.39" }
}
```

`exit.is_tor` is the important field. A `reachable: true` only proves the
SOCKS port accepted a connection; `is_tor: true` proves the traffic actually
left through a Tor exit node, from the exit node's own point of view. Both
checks run in parallel, so a broken tunnel still reports `exit` rather than
being hidden behind a failed upstream call.

An unreachable proxy is treated as a transport fault: the account cools down,
the request fails over to another account, and `/health` stays `200`.

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| `is_tor: null`, `error: "fetch failed"` | Tor not bootstrapped yet — wait for `Bootstrapped 100%` |
| `is_tor: false` | You are pointed at a plain SOCKS proxy, not Tor |
| Everything fails over at once | Tor daemon died; restart it under a supervisor |
| Works for hours, then stops | Exit node rotated to one Puter blocks; the pool cools it down and retries |
| Slow first request only | Circuit build (~2–3s); subsequent calls reuse it |

Tor adds roughly 2.5s per request to `api.puter.com` versus ~0.1s direct. That
is the cost of the anonymity, not a bug.

> **Tor cannot reach `127.0.0.1`.** If `PUTER_API_ORIGIN` points at a local mock
> or a sidecar on loopback, those requests will fail with `PUTER_PROXY=tor` —
> the exit node has no route back to your machine. Use a real origin, or leave
> that account `"proxy": null`.

---

## Loading accounts from GitHub

Point `ACCOUNT_MANIFEST_REPO` at one or more repos:

```dotenv
ACCOUNT_MANIFEST_REPO=me/puter-pool,friends/shared-pool@main:config/accounts.json
ACCOUNT_MANIFEST_TOKEN=github_pat_xxx    # only needed for private repos
```

Accepted spec forms:

| Spec | Meaning |
| --- | --- |
| `owner/repo` | `accounts.json` on the default branch |
| `owner/repo@main` | pinned ref |
| `owner/repo@main:config/accounts.json` | pinned ref and custom path |
| `https://github.com/owner/repo/blob/main/accounts.json` | full URL |

Fetching uses the Contents API so private repos work with a token, and falls
back to `raw.githubusercontent.com` (unauthenticated) for public repos — which
also avoids the anonymous API rate limit. A repo that fails to load is logged
and skipped; it never prevents the server from booting with the accounts it did
resolve.

Accounts added at runtime through `POST /v1/accounts` are persisted to the local
manifest with mode `0600`.

---

## Error handling

Every response — success or failure — is JSON with a stable `request_id` that
also appears in logs.

```json
{
  "ok": false,
  "request_id": "afb0e073-...",
  "error": {
    "code": "unauthorized",
    "message": "Missing X-API-Key header",
    "details": { "hint": "Send the key as the X-API-Key header." }
  }
}
```

| Code | Status | Meaning |
| --- | --- | --- |
| `unauthorized` | 401 | Missing or invalid `X-API-Key` |
| `forbidden` | 403 | Key lacks the required scope |
| `invalid_json` | 400 | Body is not valid JSON |
| `invalid_request` | 400 | Bad operation, missing field, wrong type |
| `payload_too_large` | 413 | Exceeded `BODY_LIMIT` |
| `not_found` | 404 | No such route or account |
| `upstream_unauthorized` | 401 | Puter rejected the token |
| `upstream_quota_exhausted` | 402 | Account out of credits |
| `upstream_forbidden` | 403 | Token lacks permission |
| `upstream_not_found` | 404 | Model or upstream resource not found |
| `upstream_rejected` | 400 | Puter rejected the request for another 4xx reason |
| `upstream_rate_limited` | 429 | Rate limited, with `Retry-After` |
| `upstream_timeout` | 504 | Exceeded `REQUEST_TIMEOUT_MS` |
| `upstream_unreachable` | 502 | Network or proxy failure |
| `upstream_error` | 502 | Puter returned 5xx |
| `no_account_available` | 503 | Every account is cooling down or dead |
| `rate_limited` | 429 | *Your* client exceeded `RATE_LIMIT_PER_MINUTE` |

`Retry-After` is set on `429` responses whenever the upstream supplied one.

---

## Security model

- **Two independent layers.** `X-API-Key` proves the caller may use the proxy;
  the account token proves the proxy may use Puter. Compromising one does not
  yield the other.
- **Constant-time key comparison** over fixed-length SHA-256 digests, so neither
  timing nor key length leaks anything. Loop all keys without early exit.
- **Tokens never leave the process.** Admin responses expose a 12-character
  fingerprint. Logs mask tokens to `eyJh…9f2c` and redact any field matching
  `token|authorization|api_key|secret|password|cookie`.
- **Scope separation.** Ordinary keys cannot enumerate accounts, pin an account,
  or reach raw driver calls.
- **Input cannot poison the pool.** Only upstream faults affect account health.
- **Bounded blast radius.** Helmet with CSP off (there is no document), explicit
  opt-in CORS allowlist, body limit, per-key rate limiting, and an upstream
  deadline on every request.
- **No ambient credentials.** Nothing is hardcoded; the process refuses to start
  in production without an explicit key.

Deployment notes: terminate TLS in front of the proxy, keep `HOST=127.0.0.1`
unless fronted by a reverse proxy, set `TRUST_PROXY=1` when you are, and treat
`.env` and `accounts.json` as secrets (`0600`).

---

## Operations tooling

```bash
npm run accounts:add      # append an account to the local manifest
npm run accounts:check    # probe every account's credential
npm run accounts:sync     # pull manifests from configured repos
npm test                  # 52 tests
```

---

## Tests

The suite runs against a mock Puter upstream through the real Express app and
the real SDK, so routing, auth, failover, and error translation are exercised on
their actual code paths.

```bash
npm test
```

Coverage includes: auth and scope enforcement, error-code mapping for
401/402/403/429/502/504, failover and cooldown behaviour, 40-way concurrent
account isolation (asserting token-to-account pairing under parallelism),
Tor shorthand expansion, unreachable-proxy recovery, GitHub manifest loading
with API and raw-fallback paths, and API-key parsing edge cases.

A manual smoke harness boots the mock and the real server together:

```bash
node test/live.js
```

### A note on the SDK retry loop

`@heyputer/puter.js` transparently replays a `429` **up to nine more times over
about 14 seconds** before surfacing the error. Left alone this silently defeats
account failover — the pool would never see the failure in time to switch
accounts.

The per-account fetch wrapper detects a `429`, records the *true* status out of
band, and returns a terminal `4xx` body so the SDK stops retrying. The pool then
decides whether another account is worth trying. The real status is recovered
from `AsyncLocalStorage`, because the SDK discards HTTP status codes and reports
only the response body.
