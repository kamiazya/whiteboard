# ADR-0005: Authorizing a hosted origin against the local daemon

**Status:** Accepted — not yet implemented. Revised twice after adversarial review; the *Corrections* section records what the earlier drafts got wrong.

**Builds on ADR-0002 (browser-to-daemon transport), which already decided:**

- **The transport works.** Its addendum measured a real hosted HTTPS page against a loopback daemon: **Chromium succeeds** once the Local Network Access permission is granted, **Firefox succeeds** with no prompt, **WebKit/Safari is blocked** (it applies no loopback mixed-content exemption). Hosted↔loopback is therefore viable on Chromium and Gecko and *not* on Safari; mkcert/HTTPS-daemon is the WebKit-compatibility option, not a prerequisite.
- **Token carriers are restricted to two channels** — the WS subprotocol and the HTTP `Authorization: Bearer` header. URL query parameters, `runtimeConfig`, and build artifacts are prohibited. The daemon-served app receives its token through a dedicated `window.__WHITEBOARD_DAEMON_TOKEN__` global, read once into an in-memory store; ADR-0002 is explicit that this is a serialization-surface reduction, **not** a security boundary.
- **Canvas/asset `GET` is deliberately tokenless** in local-daemon mode, relying on loopback bind + Host-loopback check + hard-to-guess ids, so `<img src>` thumbnails keep working. ADR-0002 records the residual risk (another localhost page can read canvases via reflected CORS) and names an origin allowlist as the mitigation.

This ADR decides the part ADR-0002 left open: **how a hosted origin is authorized**, rather than how its bytes reach the daemon.

## Context

The product's value is this: **open the familiar hosted URL, keep every byte of your data on your own machine, and edit with an AI agent.** The daemon is what makes that possible — it holds the canvases locally, speaks MCP to the agent, and syncs the browser over a WebSocket. It is also what will make offline editing and AI/human edit-conflict recovery possible, because the canvas is a Loro CRDT that can merge divergent edits rather than clobbering them.

That value statement decides the architecture. The hosted origin is **the entry point users know**. Sending them to `http://127.0.0.1:3099` instead is not a workaround — it is abandoning the product. So a hosted HTTPS page **must** be able to talk to a loopback daemon, and the authorization design has to earn that safely rather than route around it.

Today only one connection mechanism exists: an AI agent calls the `create_pairing_link` MCP tool, which mints `https://<hosted-origin>/#wb=<payload>` carrying the daemon's **bootstrap token in the URL fragment**. The page consumes the fragment (`history.replaceState` strips it) and holds a raw bearer token. Hosted origins must appear in `WHITEBOARD_ALLOWED_WEB_ORIGINS`.

Two problems follow.

**A human without an AI agent has no path at all.** Dogfooding lands the user in Browser-only mode with no way forward; "ask your agent for a pairing link" is a dead end. This is the whole of the `daemon-auto-discovery-negotiation` finding.

**The credential travels as a URL.** A raw bearer token in a fragment is usable the instant it leaks — an extension reading `location.hash` before the app strips it, a screenshot, a paste into a chat window. Nothing binds it to the page it was minted for, to a scope, or to a lifetime.

## Decision

Three connection paths.

### 1. Local human, no hosted page → the daemon's own origin

On startup, an interactive daemon **opens the user's default browser at its own origin**, where it serves the same `apps/web` build and injects the token server-side into the HTML. **No token appears in any URL**, and there is no pairing step.

This is not "no credential exposure": the token lands in `window.__WHITEBOARD_DAEMON_TOKEN__` (`app.ts`), so a same-origin XSS or a malicious extension can read it. It is *URL* exposure that is eliminated.

Suppressed whenever a browser would be nonsense: no interactive TTY, `CI` set, inside a container, server-mode, non-loopback bind, or opted out.

### 2. Hosted origin → daemon (the product's main path)

The daemon becomes an OAuth 2.1 Authorization Server for its own API:

- `GET /.well-known/oauth-protected-resource` (RFC 9728) and `GET /.well-known/oauth-authorization-server` (RFC 8414).
- `GET /authorize` — a **local approval surface served by the daemon at its own origin**. The user approves *there*, on a surface the requesting page cannot draw, frame, or click.
- `POST /token` — authorization-code exchange with **PKCE (S256)**, enforced at both issuance and redemption: `code_challenge` required, verifier compared exactly, code single-use with a short TTL, and a request without `code_verifier` **rejected server-side**. `state` is required as well — PKCE is not a substitute for it, and the hosted client is responsible for storing and comparing it.

**The identity shown on the approval screen is derived from the registered `redirect_uri` — never from `Origin`, `Referer`, or any request parameter.** With a fixed public `client_id`, *any* site can navigate the user to `/authorize` supplying the registered callback and its own PKCE challenge; the daemon cannot infer who initiated a top-level navigation. Deriving the displayed identity from anything the requester controls would let an attacker put a trusted name on their own consent prompt.

**Approval binds to the authorization transaction, not to the origin.** The persisted record carries: an opaque high-entropy transaction id; the client id; the exact raw registered redirect URI; the canonical requested scope set; the PKCE challenge and explicit `S256` method; creation and expiry; the daemon-instance/issuer identity; a status (`pending` → `approved` | `denied` → `code-issued` → `redeemed` | `expired`); an approval-session/CSRF binding for the approval POST (possession of a transaction id must not authorize a cross-site POST); and the authorization code stored **only as a hash**, single-use.

Redemption is a **compare-and-swap** state transition, not check-then-mark — otherwise two concurrent `/token` calls can both redeem the same code. Two tabs produce two distinct transactions. **A daemon restart has an explicit rule**: either pending transactions survive durably, or every outstanding one is invalidated and the user is told the daemon restarted and to start again. An approval screen that outlives its backing transaction is an authorization bug.

**No dynamic client registration (RFC 7591).** A fixed `client_id`, and `redirect_uri` validated by **byte-for-byte comparison against a dedicated exact-URI registry** — *not* derived from `WHITEBOARD_ALLOWED_WEB_ORIGINS`, which stores origins only and permits wildcards (`https://*.pages.dev` would otherwise admit every Cloudflare Pages project).

**Tokens: short-lived access token + a rotating, revocable renewal grant.** A creative tool is left open for hours; short-lived tokens with no renewal path would force the user through a loopback approval flow mid-session, and the pressure from that cliff would produce an unsafe exemption later. So renewal is designed now, not deferred: absolute *and* idle expiry, rotation on every use, reuse detection that revokes the whole grant family, and a visible local grant-management screen where the user can see and revoke what they granted. Sender-constraining the token (DPoP with a non-extractable WebCrypto key) is worth evaluating to blunt simple replay. Saying "no refresh token" would not create a security property — it would just push renewal into an undefined future mechanism.

**The terminal code is a headless-only fallback.** "Read me the six digits to finish setup" is an easy support-scam script, and a first-run ritual teaches users to relay it. Keep the printed code only where no approval surface can be shown.

### 3. Deliberate credential handoff → the existing `#wb=` link

`create_pairing_link` stays, correctly described: it embeds `client.baseUrl`, which is normally the sender's **loopback** URL. Opening it on another device points at *that device's* loopback, not the sender's daemon. It is therefore a handoff to **another browser or profile on the same machine** — cross-device only if a separately reachable daemon URL or tunnel exists. It is an explicitly dangerous, deliberate act, and its copy should say so.

## Why this shape

**The hosted origin is not negotiable.** An independent review argued that a loopback authorization server — LNA, CORS, redirects, consent UI, token storage, WebSocket auth — is a lot of security-critical surface merely to avoid sending users to the daemon's origin. That argument is correct in the abstract and wrong here: "the usual URL, with your data staying local" *is* the product. The surface is the cost of the value, not an accident.

**PKCE is worth having, and buys less than its branding suggests.** A stolen authorization code cannot be redeemed without the verifier, and the response is bound to the transaction that started it — a real improvement over today's `#wb=` token, which is live the moment it leaks. It does **not** protect against same-origin XSS at an approved origin, against a stolen access token, or against a user who approves an attacker.

**The local approval surface is containment, not prevention — say it that way.** Moving "Allow" to the daemon's origin stops the requesting page from drawing, framing, or silently clicking it. It does **not** stop an attacker from sending the user there; a page served by localhost may even *look* more trustworthy. What actually contains the damage is that the code is delivered only to the exact registered callback and is worthless without the PKCE verifier — an attacker who wins the click still cannot receive or redeem it. The approval screen's job is to make the decision legible: the relying party's identity derived from the registered callback (never a name the requester supplies), explicit scopes, an unmistakable consequence ("this grants `https://whiteboard.pages.dev` read/write access to your local workspace data until …" — not a generic "Connect"), default-deny, no pre-checked "always allow", rate-limited attempts, unframeable (`frame-ancestors 'none'`), and a CSRF-resistant approval POST. A deceived click is still a granted click.

**Prior art converges on origin allowlists, not OAuth** (Ollama's `OLLAMA_ORIGINS`, Figma's font helper accepting only `figma.com`, Open WebUI proxying through its own backend, Tailscale's socket + step-up). We adopt OAuth's shape for MCP-ecosystem compatibility and PKCE's leak resistance, and we keep the allowlist for browser-origin admission — but we do not pretend the allowlist is doing OAuth's job, or vice versa.

## Constraints the implementation must respect

These are the places a correct-looking implementation silently loses a property claimed above.

**The guards do not extend for free.** `api-host-guard` (the Host-header check that defeats DNS rebinding — CORS alone does not) and the CORS/LNA middleware are currently applied to `/api/*` only. `/authorize` and `/token` must have them wired explicitly; a cross-origin `POST /token` will not inherit anything by being mounted "near" the API routes.

**The resource-server half does not already exist.** `oauth-resource-strategy.ts` is a typed *seam* — it says so in its own header comment — with no signature verification and no JWKS behaviour. Reusing the `AuthDecision` vocabulary is worth something; treating the validator as done is not.

**The WebSocket is a second bearer channel, and the access token must not simply be pasted into it.** Live sync authenticates today with the raw daemon token in `Sec-WebSocket-Protocol` (`ws-auth.ts`) — which exists because the browser's WebSocket API cannot set an `Authorization` header. Putting the OAuth access token there instead would expose it to upgrade logging, middleware, and any intermediary that records headers.

The shape that works: an authenticated `fetch` mints an **opaque, single-use connection ticket** (bound to the daemon instance, the workspace, the granted scopes, and an expiry of tens of seconds). Only the ticket travels through the upgrade; it is **consumed atomically** at upgrade, and the resulting authorization context is attached to the socket. **Scope is then enforced on every WebSocket operation, not just at upgrade** — a socket that is authenticated once and then accepts everything is how a `workspace:read` token ends up writing.

Expiry mid-session has to be designed, not discovered: warn before expiry, stop accepting mutations at expiry, hold edits in a local CRDT outbox, mint a fresh ticket after renewal, reconnect with bounded exponential backoff, then merge and replay. **Do not cut a stroke in half.** Without this, the predictable failures are: a token expiring mid-draw and the canvas looking lost; every tab expiring together and stampeding the ticket endpoint; a reconnect loop racing ticket consumption so one-shot tickets look flaky.

Live sync *is* this product. Moving REST to OAuth while leaving the canvas channel on the bootstrap token would be self-deception, not a migration.

**Scopes are cosmetic until enforced.** The real scope vocabulary is `workspace:read` / `workspace:write` plus runtime/files/versions scopes (`auth-strategy.ts`) — there is no `workspace:admin`. Claiming scoped tokens requires first assigning and enforcing a scope on every REST route and every WebSocket operation.

**RESOLVED — the tokenless-`GET` carve-out is retired, not a pending prerequisite.** ADR-0002 originally left canvas/asset `GET` unauthenticated in local-daemon mode — a considered trade for working `<img src>` thumbnails, with loopback-only reachability as the containing assumption. That assumption dies the moment a *hosted* origin is a first-class client: an approved-looking page — or any page that gets past the origin allowlist — could then read every canvas without holding a token at all, which would make the whole scoped-token exercise theatre on the read path. This ADR originally deferred that decision as "a prerequisite slice." It is no longer pending: ADR-0002's third addendum records the resolution. The consumer audit found the client-side fix was already shipped for free — every thumbnail/file consumer already fetches bytes through the bearer-carrying transport and renders an object URL rather than a bare `<img src>` — so the carve-out was retired outright: local-daemon mode now requires the shared bearer on every `/api/*` request (reads included), with only `/api/runtime/ping` exempt. `canvas:read` now means something on every path, not just the server-mode OAuth path this ADR designs.

**The origin allowlist is not authentication.** It gates browser-origin admission. A missing `Origin` header is accepted by the MCP HTTP path and by WebSocket upgrades — non-browser callers are authenticated by the token, not the allowlist.

**Local Network Access is the browser gate, and Safari does not open it.** Per ADR-0002's measurements: Chromium reaches the loopback daemon only after the user grants the LNA permission (and *hangs on the pending prompt* until they decide), Firefox reaches it with no prompt, and **WebKit blocks it outright**. So the token exchange must run **inside a user gesture**, a denied or ignored prompt must surface an explicit error rather than a silent hang, and **Safari users cannot use the hosted↔daemon path at all** — they get browser-local mode, or the daemon's own origin, until an HTTPS daemon (mkcert) exists. That is a product limitation to state plainly in the UI, not to paper over.

**Shipped (2026-07-13): the connection-ticket bridge described above is implemented.** `POST /api/ws-ticket` (`route-scope-registry.ts` gates it at `canvas:read`, `ws-ticket.ts`) mints an opaque, single-use ticket bound to the presented grant's own scopes and `clientId` via `createWsTicketStore` (`ws-ticket-store.ts`), on a 30-second TTL. The client offers it in `Sec-WebSocket-Protocol` as `whiteboard-ticket.<value>` (`TICKET_WS_PROTOCOL_PREFIX`, `ws-protocol.ts`); `authorizeWsUpgrade` (`ws-auth.ts`) redeems it via a store instance shared with the minting route (`http-server.ts` constructs one `WsTicketStore` and threads it through both), and the socket's authorization context carries exactly the redeemed scopes — never `ALL_AUTH_SCOPES`. Redemption is compare-and-swap, so a replayed ticket 401s; an offered ticket with no accompanying base protocol is rejected without touching the store, leaving a still-valid ticket usable on a corrected retry. Server-side (`mcp-node`) tests now cover the "already-consumed connection ticket cannot reconnect" and "raw OAuth access token cannot authenticate a hosted-origin socket" items in the acceptance gate below; the gate itself still asks for browser-level proof, which this slice does not add. **Not yet done:** mid-session expiry handling (outbox, warn-before-expiry, reconnect-with-backoff), DPoP sender-constraining, and the renewal-grant screen remain open — this slice covers only the upgrade-time bridge, not what happens when a session outlives one ticket's 30-second mint-to-connect window (a fresh ticket per reconnect attempt is the only path today).

**Re-measured (2026-07-12): the WebSocket upgrade is not currently gated behind LNA, on the tested Chromium build (147.0.7727.15).** ADR-0002's addendum had left this open — Chromium's WS gating "was not yet shipped" as of the 2026-07-08 measurement. A committed harness (`pnpm --filter @kamiazya/whiteboard-mcp smoke:lna-transport`) re-drove all three engines against the real hosted origin, this time probing a `WebSocket` upgrade to a loopback target alongside `fetch`. Result: a page whose LNA permission state is still `prompt` (never granted, `fetch` to the same loopback target fails) can nonetheless open a raw loopback WebSocket successfully. **So the connection-ticket `fetch` and the socket open do *not* currently need to sit inside the same granted permission — no permission is required for the socket at all.** This is a currently-observed gap in Chromium's rollout (tracked upstream as unshipped), not a property the design should assume permanently: the ticket-minting `fetch` must still surface a denied/blocked LNA grant as an explicit error, and the harness should be re-run whenever a Chromium version bump lands, in case WS gating ships and starts requiring the same grant the `fetch` needed. Firefox and WebKit behave as ADR-0002 already described for `fetch` (Firefox: no gating either way; WebKit: blocked either way).

**The daemon-served app is not the hosted client.** It receives a raw injected token and attaches it to same-origin requests. It must stay out of the OAuth state, storage, callback, and refresh paths entirely — not merely carry a different `client_id`.

## The most likely way this ships broken

**Scope bypass on live sync.** OAuth works in the REST demo, the WebSocket authenticates once at upgrade and then accepts every message, and a `workspace:read` token writes freely — or the raw bootstrap token stays accepted "for compatibility" forever. This is the likely failure precisely because scopes are the part that is easy to *claim* and tedious to *enforce*, and because the socket is where enforcement is least visible.

So the acceptance gate is adversarial, not demonstrative. Before this can be called done, browser-level tests must prove:

- a `workspace:read` token **cannot** emit a CRDT mutation over the socket;
- an expired socket **cannot** mutate;
- an already-consumed connection ticket **cannot** reconnect;
- a raw bootstrap token **cannot** authenticate a hosted-origin socket;
- an authorization code **cannot** be redeemed twice under concurrent `/token` calls;
- a request without `code_verifier` is rejected;
- `/authorize` **cannot** be framed, and its approval POST **cannot** be ridden cross-site.

Each of these is a way the design silently degrades into the thing it replaced.

## Consequences

The `#wb=` mechanism narrows to a deliberate, explicitly-dangerous handoff and stops being what a human is told to use.

The daemon gains a real authorization-server surface: two metadata documents, an approval UI, two endpoints, a transaction-bound consent record, an exact redirect-URI registry, and scope plumbing across REST *and* WebSocket. This is more work than the first draft of this ADR assumed.

**What this does not fix:** a user who approves a malicious origin has approved it. We should not tell ourselves the protocol solved that.

## Corrections to the first draft

Recorded because they were wrong in ways the code plainly contradicted, and the same mistakes are easy to repeat:

- `#wb=` was described as cross-device sharing. It embeds the sender's loopback URL; it is same-machine handoff unless remote reachability exists.
- `workspace:admin` was invented; the codebase has no such scope.
- `oauth-resource-strategy.ts` was described as an existing resource-server implementation. It is a seam with no validator.
- The WebSocket bearer channel was not accounted for at all.
- `redirect_uri` exact-path matching was to be derived from the origin allowlist, which stores no paths and permits wildcards — structurally impossible.
- The terminal code was called "the only control that defeats social engineering." It is a possession check that a support scam can talk through, and a first-run ritual teaches relaying it.
- The approval surface was presented as a social-engineering *defence*. It is containment: it stops the requesting page from drawing or clicking the prompt, but not from sending the user to it. What makes a won click useless to the attacker is the registered callback plus PKCE, not the screen.
- The identity to display was left unspecified, which would have let an attacker supply it. It must be derived from the registered `redirect_uri` alone.
- "No refresh token" was adopted as a security property. It is not one — it merely defers renewal to an undefined mechanism, and a tool people leave open for hours would have forced an unsafe exemption later.
- The WebSocket was named but not designed. Pasting the access token into `Sec-WebSocket-Protocol` would have exposed it to upgrade logging; a one-shot connection ticket plus per-operation scope enforcement is the shape that works.
- **Two drafts were written without reading ADR-0002**, which had already decided the transport, measured LNA across all three engines (including Safari being blocked), fixed the permitted token carriers, and deliberately left canvas `GET` tokenless. "Reads are unguarded" was reported here as a discovery; it is a documented, accepted trade-off — one that nonetheless has to be revisited before a hosted origin can be a first-class client.
