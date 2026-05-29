# Portless local dev origin strategy (investigation)

Status: **investigation / feasibility gate**, not a production behavior change.

This document evaluates whether [Portless](https://github.com/vercel-labs/portless)
can become an *optional* high-fidelity local development path for the **web app**
(`apps/web`). It does **not** change production behavior, the local-daemon origin
gate, or the Cloudflare Pages deploy contract.

Scope (per architect): this slice covers **`apps/web` origin-fidelity only** —
preview-origin policy, Wrangler/Vite compatibility, and QA/dogfooding. **Local
daemon pairing over a Portless origin is explicitly out of scope and unsupported
for now** (see [Daemon pairing is unsupported](#daemon-pairing-is-unsupported-on-portless-origins)).

Baseline development must keep working without Portless.

## Why a named-origin path is interesting

Plain `localhost:<port>` is enough for everyday development, but it does not
exercise the same class of origin behavior the product depends on:

- Cloudflare Pages production origin is treated as an exact trusted origin.
- Pages preview origins must not silently enter browser-local or local-daemon
  trusted mode.
- Browser-local data is origin-scoped, so dev origin churn can hide migration,
  recovery, and returning-user issues.

Portless offers stable named `.localhost` HTTPS origins, monorepo app mapping,
and worktree-aware hostnames, which can surface origin-sensitive bugs earlier.

## Two-tier development flow

### Baseline (no Portless required)

```bash
# whiteboard daemon + MCP HTTP endpoint + vite (see package.json)
pnpm dev

# web app only
pnpm --filter @kamiazya/whiteboard-web dev   # vite, http://localhost:5173
```

- The local daemon binds loopback only and exposes MCP at `http://127.0.0.1:3099`.
- The web app runs on plain `http://localhost:<port>`.
- This path requires no CA trust, no privileged bind, and no service install.

**Baseline must remain the documented default.** Everything below is additive.

### Enhanced origin-fidelity path (optional, Portless, web app only)

Serve the **web app** behind a stable named HTTPS origin (for example
`https://whiteboard.localhost`) to exercise HTTPS, named origins, and
preview-origin behavior closer to the hosted deployment.

This path is for **web origin-fidelity verification only**. It does **not**
attempt local daemon pairing — that is unsupported on Portless origins under the
current origin gate (next section).

> Portless setup (global install, `portless service install`, local CA trust,
> privileged 443 bind) is an **explicit manual step performed by the
> contributor**. It is intentionally *not* run from any repo script. See
> [Repo boundary](#repo-boundary-what-this-repo-does-and-does-not-do).

### What to serve behind Portless (Q2, decided)

Per the design-architect decision:

- **Origin-fidelity target = the built `dist/` preview (`vite preview`).** It uses
  the existing `apps/web` `preview` script (`vite preview`), so it adds **zero new
  dependencies**, and it serves the same built artifact whose `_headers`/CSP apply.
- **`vite dev` is excluded from origin-fidelity claims.** Keep it for fast
  iteration, but do not treat dev-served behavior as production-faithful.
- **`wrangler pages dev` is a future option, not adopted here.** It is the closest
  to Cloudflare Pages but adds a new required dependency and exceeds this slice's
  docs / no-prod-change scope. Adoption requires a separate proposal — see the
  follow-up issue `tmp/issues/2026-05-29-portless-wrangler-pages-dev-future.md`.

You must bind the server explicitly to the host/port Portless assigns, because
vite does not read Portless's injected `PORT`/`HOST` env vars (see
[Known limitation](#known-limitation-vite-bind-mismatch--502)). Verified working
forms:

```bash
# Origin-fidelity: build, then serve the dist preview behind Portless.
pnpm --filter @kamiazya/whiteboard-web build
portless whiteboard pnpm --filter @kamiazya/whiteboard-web exec \
  vite preview --host 127.0.0.1 --port "$PORT"

# Fast iteration only (NOT origin-fidelity): vite dev with the same explicit bind.
portless whiteboard pnpm --filter @kamiazya/whiteboard-web exec \
  vite --host 127.0.0.1 --port "$PORT"
```

> The `vite preview` server has no `server`/`preview` block in
> `apps/web/vite.config.ts` either, so it needs the same explicit
> `--host 127.0.0.1 --port` bridging as `vite dev`; otherwise it 502s for the same
> reason. (qa to confirm the preview path live; the mechanism is identical to the
> dev case below.)

#### Known limitation: vite bind mismatch → 502

The naive form `portless whiteboard pnpm --filter @kamiazya/whiteboard-web dev`
returns **502 Bad Gateway** out of the box:

- Portless sets `PORT`/`HOST` env and routes `https://whiteboard.localhost` to
  the assigned port, but `apps/web/vite.config.ts` has no `server` block, so vite
  ignores those env vars and binds to its default `::1:5173`.
- Nothing listens on the routed port → 502. The same happens with
  `portless alias whiteboard 5173` because vite binds IPv6 `::1` only while the
  alias targets IPv4 `127.0.0.1`.
- CA trust / HTTPS themselves work (`ssl_verify_result=0`); the host
  `whiteboard.localhost` is not rejected by vite. The cause is purely a
  port/host bind mismatch.

Use the explicit `--host 127.0.0.1 --port` form above as the contributor
workaround. Teaching `vite.config.ts` to honor `PORT`/`HOST` env (so the naive
form just works) is a dev-server change tracked separately as a future task
(owner: pm-triage) — it is out of scope for this docs slice.

## The real local-daemon origin gate

The origin check that actually runs on local-daemon requests is **hostname-keyed
and scheme/port independent**, not a string allowlist.

- **HTTP `/mcp` gate:** `packages/mcp-server/src/server/security/mcp-http.ts`
  → `isAllowedMcpHttpOrigin(origin, host)` / `isLoopbackHostname(hostname)`,
  wired at `packages/mcp-server/src/server/app.ts:376`
  (`app.use('/mcp', createMcpHttpOriginMiddleware())`).
  - It parses the `Origin` header and checks only its **hostname** against the
    loopback set `localhost` / `127.0.0.1` / `::1`. Scheme (`http`/`https`) and
    port are ignored.
- **WebSocket gate:** `packages/mcp-server/src/server/routes/ws-auth.ts` applies
  the same loopback-hostname rule, and additionally requires
  `origin.hostname === requestHost`.

> **Do not** cite `LOCAL_DAEMON_ALLOWED_ORIGINS` /
> `isOriginAllowedForServerMode` in `server-mode-exposure.ts` as the daemon gate.
> Those two exports have **no non-test callers** (referenced only by their own
> unit test). The module's other export, `resolveServerModeExposure`, *is* used
> (by `server-mode-auth-plan.ts` for *server-mode* planning), but that is a
> separate concern from the local-daemon `/mcp` and WebSocket request gates above.
> Any future change to the daemon origin policy happens in `mcp-http.ts`
> (`isLoopbackHostname` / `isAllowedMcpHttpOrigin`) and `ws-auth.ts`, **not** in
> `LOCAL_DAEMON_ALLOWED_ORIGINS`.

### What this means for named origins

- `https://whiteboard.localhost` → hostname `whiteboard.localhost` is **not** in
  the loopback set → **rejected**. (The conclusion that Portless named origins
  cannot pair with the daemon holds; the *reason* is the hostname check, not a
  scheme/string allowlist.)
- `https://localhost` / `https://127.0.0.1` → hostname *is* loopback → would be
  **accepted** (scheme and port are ignored). The gate is therefore more
  permissive on scheme/port than a "loopback-http only" reading would suggest;
  it is strict only on **hostname**.

## Daemon pairing is unsupported on Portless origins

For this slice, daemon pairing from a Portless origin is **unsupported**, by
design and by the current gate:

- A browser served at `https://whiteboard.localhost` sends
  `Origin: https://whiteboard.localhost`. The daemon `/mcp` and WebSocket gates
  reject it because the hostname `whiteboard.localhost` is not loopback.
- Enabling it would require changing the **hostname-loopback rule** in
  `mcp-http.ts` (and `ws-auth.ts`) to admit a specific named origin. That is a
  security-sensitive change requiring formal security-reviewer sign-off and
  regression coverage — out of scope here.

This slice does **not** make that change. See
[Future item](#future-item-for-security-reviewer-named-origin-daemon-pairing).

### What is *not* the barrier

The Cloudflare Pages CSP (`apps/web/public/_headers`) `connect-src` allows
`http://127.0.0.1:*`, `ws://127.0.0.1:*`, `http://localhost:*`, and
`ws://localhost:*`, so a page *is* permitted by CSP to reach the loopback daemon.
CSP is not the blocker; the daemon-side hostname-loopback gate is.

## publicOrigin and the production exact-origin policy

The running web app always goes through the **hosted** resolver, in both dev and
production. The single app entry uses it directly:

```text
apps/web/src/App.tsx:7   resolveHostedProviderStateFromRaw(__WHITEBOARD_RUNTIME_CONFIG__ ?? {}, window.location.origin)
```

`resolveHostedProviderStateFromRaw` (`apps/web/src/lib/provider.ts:62-71`) rejects
Cloudflare Pages *preview* browser origins and delegates config parsing to
`resolveHostedRuntimeConfig` (`apps/web/src/runtime-config.ts:40-46`), which throws
unless `publicOrigin` is the production `pages.dev` origin
(`isProductionPagesOrigin`).

Consequence (qa-verified live behavior): injecting
`publicOrigin: 'https://whiteboard.localhost'` yields `data-provider="invalid-config"`
**even in local dev**, because the app is still on the hosted resolver path. So:

- `publicOrigin` must be the production `pages.dev` origin, or absent.
- When the web app is served via Portless, **do not inject `publicOrigin`** — the
  app then resolves to browser-local mode (the default). A Portless origin is a
  serving origin, not a `publicOrigin`.

The permissive `resolveRuntimeConfig` is **not unused** — it is wired into the
exported `resolveProviderStateFromRaw`:

```text
apps/web/src/lib/provider.ts:49  export function resolveProviderStateFromRaw(raw: unknown): ProviderState {
apps/web/src/lib/provider.ts:51    return resolveProviderState(resolveRuntimeConfig(raw))
```

— but the **running app does not call that path**; `App.tsx` uses the hosted
variant, and `resolveProviderStateFromRaw` has no non-test caller. So the
permissive resolver does not relax the running app's origin policy.

### Two distinct origin checks — do not conflate them

`resolveHostedProviderStateFromRaw` applies **two separate** checks. They operate
on different inputs and must be described separately:

1. **Serving (browser) origin — preview rejection.** `provider.ts:63` runs
   `classifyPagesOrigin(browserOrigin)` on `window.location.origin` and returns
   `invalid-config` if it is a Cloudflare Pages *preview* origin. This stops a
   Pages preview deploy from silently entering browser-local mode. The comment at
   `provider.ts:60-61` ("localhost is allowed for local dev") refers to **this
   check** — i.e. a `localhost` *serving* origin is not treated as a preview
   origin. It does **not** say anything about which `publicOrigin` *values* are
   accepted.
2. **Injected `publicOrigin` value — production-only validation.**
   `resolveHostedRuntimeConfig` (`runtime-config.ts:42-43`) throws when
   `publicOrigin` is set to anything other than the production `pages.dev` origin;
   `provider.ts:68` catches that and returns `invalid-config`. This is why an
   injected `publicOrigin: 'https://whiteboard.localhost'` fails even though the
   *serving* origin `https://whiteboard.localhost` is itself fine.

Additionally, `bareOriginSchema` (`runtime-config.ts:10`,
`url.origin === v && !url.hostname.includes('*')`) rejects wildcard hosts, so a
`publicOrigin` like `https://*.whiteboard.localhost` is also invalid — consistent
with this slice's exact-origin-only stance.

Net: the production exact-origin policy is not just preserved, it is enforced on
the running app even in local dev (stricter than a naive "local dev accepts any
origin" reading). (Answers SoT Q4.)

## Preview-origin rejection still applies behind Portless

`apps/web/scripts/smoke-preview-origin.mjs` injects a preview `pages.dev`
`publicOrigin` and asserts the app refuses to enter browser-local mode
(`<main data-provider="invalid-config">`). This rejection is driven by the
**injected `publicOrigin` value**, not by the transport/serving origin, so it
behaves the same whether served via plain vite or behind Portless. (Answers SoT Q5.)

## Wrangler compatibility investigation checklist

Status legend: ✅ answered by static analysis · **decided** design decision
recorded · **future** deferred to a separate proposal · ❓ requires a live
Portless run (handed to qa via pm — see [Repo boundary](#repo-boundary-what-this-repo-does-and-does-not-do)).

| # | Question (from SoT) | Status | Notes |
|---|---------------------|--------|-------|
| 1 | Can `wrangler pages dev` run behind Portless without breaking routing? | **future** | Not adopted in this slice (decided). `wrangler pages dev` adds a new required dependency and exceeds the docs/no-prod-change scope; deferred to a separate proposal — `tmp/issues/2026-05-29-portless-wrangler-pages-dev-future.md`. |
| 2 | Should Portless wrap vite dev, built `dist/` preview, or `wrangler pages dev`? | **decided** | **built `dist/` preview (`vite preview`)** = the origin-fidelity target (existing `apps/web` script, zero new deps). **`vite dev`** = fast iteration, non-fidelity. **`wrangler pages dev`** = future (see Q1). |
| 3 | Does `_headers` behavior matter in local preview, or only in built-artifact smoke? | ✅ | `_headers` (CSP etc.) is applied by Cloudflare Pages serving (`wrangler pages dev`/Pages), not by vite dev. CSP fidelity only appears on the artifact path. |
| 4 | Can `publicOrigin` be a Portless origin without weakening production exact-origin policy? | ✅ | The running app always uses the hosted resolver (`App.tsx:7`), so a Portless `publicOrigin` is rejected as `invalid-config` even in local dev (qa-verified). Serve via Portless **without** injecting `publicOrigin` → browser-local. Production policy is enforced, not weakened. |
| 5 | Does the preview-origin rejection path still work via Portless? | ✅ | Yes — config-value driven, transport-independent. |
| 6 | Does daemon pairing need a separate explicit allowlist entry for the Portless origin? | ✅ | Out of scope this slice. The real gate is hostname-loopback (`mcp-http.ts` / `ws-auth.ts`); a named origin is rejected. Pairing is **unsupported** here — see [Future item](#future-item-for-security-reviewer-named-origin-daemon-pairing). |
| 7 | Does browser storage stay origin-scoped across baseline localhost, Portless origin, and worktree hostnames? | ❓ | Origin-scoping is a browser guarantee, but the *product* implication (data appears to "disappear" when switching origins) needs a live multi-origin dogfood. Handed to qa. |

## QA / dogfooding manual checklist

To be run by someone with Portless installed (qa, via pm handoff). None of these
steps may be automated into `pnpm dev` or CI. **Daemon-pairing success is not an
expected outcome of this slice** — it is unsupported on Portless origins.

- [ ] Baseline still works with Portless absent: `pnpm dev` and
      `pnpm --filter @kamiazya/whiteboard-web dev` start and the app loads on
      plain `localhost`.
- [ ] Origin-fidelity: build (`pnpm --filter @kamiazya/whiteboard-web build`) and
      serve the dist preview behind Portless with the explicit
      `vite preview --host 127.0.0.1 --port "$PORT"` form (see
      [What to serve behind Portless](#what-to-serve-behind-portless-q2-decided)).
      The page loads over HTTPS with a trusted local CA (no cert warning). Confirm
      whether `vite preview` needs the same explicit bind as `vite dev` (expected:
      yes; the naive form 502s for the same reason).
- [ ] Preview-origin rejection: confirm a preview `pages.dev` `publicOrigin` is
      still rejected when served behind Portless.
- [ ] Browser-local storage: create data on baseline `localhost`, then load via
      `https://whiteboard.localhost`; confirm the origin change scopes storage
      separately (data does not silently appear/disappear in a confusing way).
- [ ] Revert: confirm you can return to baseline `pnpm dev` on plain `localhost`
      by following the docs, with no leftover Portless requirement.

> Out of scope for this checklist (moved to the future item): verifying that
> daemon pairing succeeds from a Portless origin. Under the current gate it will
> be **rejected**, and that is the expected, documented behavior for now.

## Future item (for security-reviewer): named-origin daemon pairing

If a contributor later wants Portless-origin daemon pairing, it must be a
separate, opt-in slice (**T-11b / T-12: "opt-in named-origin daemon allowlist
design"**), not part of T-11. Defaults stay loopback-only.

Security-reviewer review points for that future work:

1. **Real change point.** The hostname-loopback rule lives in
   `mcp-http.ts` (`isLoopbackHostname` / `isAllowedMcpHttpOrigin`) and
   `ws-auth.ts`. Any opt-in must modify these, **not**
   `LOCAL_DAEMON_ALLOWED_ORIGINS` (which is unwired/dead for this path).
2. **Exact allowlist model.** A single, explicitly-configured origin
   (`https://whiteboard.localhost`) only — never a default-on entry.
3. **Worktree subdomain handling.** Worktree hostnames must not become
   auto-trusted; they need a separate decision.
4. **Wildcard ban.** No `*.localhost` / `*.whiteboard.localhost` patterns.
5. **Token / session binding.** How daemon auth tokens/sessions bind to the
   admitted named origin.
6. **CORS / Origin semantics.** Response `Access-Control-Allow-Origin` reflection
   and `Vary: Origin` behavior for the admitted origin.
7. **CSRF / drive-by localhost.** A named HTTPS origin widens the drive-by attack
   surface beyond pure loopback; evaluate CSRF exposure.
8. **CA trust / service install doc boundary.** Keep these as documented manual
   steps; never repo-automated.

## Repo boundary: what this repo does and does NOT do

Does:

- Document optional Portless setup and the two-tier flow (web app only).
- Keep all baseline commands working without Portless.
- Use exact named origins in examples.
- Keep `portless service install`, CA trust, and privileged 443 bind as explicit
  manual contributor steps.
- Route any future named-origin daemon-pairing work to security-reviewer.

Does **not**:

- Run `portless service install` (or any service install) from repo scripts.
- Require Portless in CI or as a required dev dependency.
- Add wildcard or worktree-subdomain trusted origins.
- Change the local daemon origin gate in this slice.
- Replace Cloudflare deploy / artifact smoke with Portless-only checks.
- Treat Portless as proof that Wrangler Pages behavior is correct.

## Follow-up

- Live Portless run for web origin-fidelity via the **built `dist/` preview**
  (`vite preview`) path — qa via pm. Confirm the preview bind (checklist Q2 note)
  and browser-storage origin scope (checklist Q7). Daemon-pairing success is
  explicitly *not* expected.
- `wrangler pages dev` behind Portless (checklist Q1) — deferred:
  `tmp/issues/2026-05-29-portless-wrangler-pages-dev-future.md`.
- Teaching `apps/web/vite.config.ts` to honor Portless `PORT`/`HOST` env so the
  naive command works — separate dev-server task:
  `tmp/issues/2026-05-29-portless-vite-bind-mismatch.md`.
- T-11b / T-12 (separate, opt-in): named-origin daemon pairing design, gated on
  formal security-reviewer review and regression coverage.

## References

- SoT note: `tmp/notes/2026-05-29-portless-local-dev-origin-strategy.md`
- **Real local-daemon `/mcp` origin gate:**
  `packages/mcp-server/src/server/security/mcp-http.ts`
  (`isAllowedMcpHttpOrigin`, `isLoopbackHostname`), wired at
  `packages/mcp-server/src/server/app.ts:376`.
- **WebSocket origin gate:** `packages/mcp-server/src/server/routes/ws-auth.ts`.
- Server-mode config contract (separate concern; `isOriginAllowedForServerMode` /
  `LOCAL_DAEMON_ALLOWED_ORIGINS` are *not* the local-daemon gate):
  `packages/mcp-server/src/server/security/server-mode-exposure.ts`.
- App entry + resolver wiring (running app uses the hosted resolver):
  `apps/web/src/App.tsx:7`, `apps/web/src/lib/provider.ts:49-71`.
- Runtime config / publicOrigin resolvers: `apps/web/src/runtime-config.ts:31-46`.
- Preview-origin smoke: `apps/web/scripts/smoke-preview-origin.mjs`.
- Pages security headers / CSP: `apps/web/public/_headers`.
- Web dev server config (no `server` block → ignores Portless `PORT`/`HOST`):
  `apps/web/vite.config.ts`.
- Pages deploy contract & portless roadmap note: `docs/pages-deploy-mvp.md`.
