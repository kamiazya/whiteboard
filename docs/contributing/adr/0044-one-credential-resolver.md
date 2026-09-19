# ADR-0044: One resolver answers what a credential carries; a surface decides only what it needs

**Status:** Proposed — human gate pending; nothing implemented. Written
because [ADR-0043](0043-authority-as-keys.md)'s first slice shipped a
credential that reached two of four surfaces and was wired into none of them,
and every existing rung reported success. Absorbs the unwired `AuthStrategy`
seam in `security/auth-strategy.ts` rather than adding a sixth component
beside it.

## Context

### What happened, measured rather than recalled

ADR-0043 decision 9's first slice added a macaroon credential to the daemon.
It landed as three commits, each with tests, each green:

- `security/macaroon.ts` — mint / attenuate / verify, 19 tests including
  libmacaroons' own reference vectors.
- `routes/auth.ts` — a macaroon branch on `/api/*`, 11 tests.
- `routes/ws-auth.ts` — a macaroon branch on the websocket upgrade, 9 tests.

**`createMacaroonRootKey` had zero production callers.** Neither `createApp`
nor the upgrade listener passed `macaroonRootKey`, so in the running daemon
every macaroon got a 401 while 39 tests reported the feature working. Review
found it; nothing in the suite could have, because each test hands the root
key to the middleware itself and therefore passes whether or not a
composition root ever supplies one.

Fixing the HTTP half exposed the second half. With `createApp` wired,
**removing `macaroonRootKey` from the `authorizeWsUpgrade` call still left all
eleven websocket tests green** — the same blind spot, one surface over,
invisible until it was mutation-checked by hand.

`knip` cannot see either: a test importing an export counts as using it, so a
feature whose only consumer is its own test suite is not dead code by that
measure.

### The structural cause is a shape, not an oversight

Every credential is an **optional positional parameter** on every surface:

```ts
createDaemonAuthMiddleware(token?, grantStore?, pairingTokens?, macaroonRootKey?)
authorizeWsUpgrade(headers, token?, allowedOrigins?, redeemTicket?, pairingTokens?, macaroonRootKey?)
```

Four optionals and five. An omitted argument and a deliberate "this daemon
mints no macaroons" are the same call. That is the defect: the type system
has been asked to express a configuration choice with the one construct that
cannot distinguish a choice from a forgetting.

### The reach gap the same shape hides

Reading the four mounted surfaces rather than recalling them:

| credential | `/api/*` | WS upgrade | `/mcp` local-daemon | `/mcp` server-mode |
|---|---|---|---|---|
| daemon token | yes | yes | yes | n/a |
| OAuth grant | yes | via ws-ticket | **no** | yes |
| origin-bound pairing token | yes | yes | **no** | n/a |
| ws connection ticket | n/a | yes | n/a | n/a |
| macaroon (ADR-0043) | yes | yes | **no** | **no** |

`/mcp` in local-daemon mode goes through `createMcpHttpAuthMiddleware` over
`createLocalTokenMcpHttpAuthStrategy`, which compares the daemon token and
nothing else. Three credentials do not reach it. **None of those three
absences was decided** — each is where a diff stopped, and nothing anywhere
asked the question.

This matters most for the macaroon, because `/mcp` is the surface an agent
actually calls. ADR-0043 decision 9's whole purpose is giving the agent
something narrower than the daemon token, and the one surface it has to reach
is the one it does not.

### There is already a component for this, mounted nowhere

`security/auth-strategy.ts` exports a sync `AuthStrategy`,
`createLocalTokenAuthStrategy`, and `createAuthStrategyMiddleware`. They are
referenced only by their own tests, their own comments, and ADR-0043's first
correction pass. The module header states the intent exactly — a typed seam
"so future server-mode strategies can plug into the same call site without
each route re-deriving its auth posture" — and then no call site uses it.

So the unification this ADR describes was attempted, and the attempt failed
in a way worth recording: **it returned a yes/no, not a grant.** A surface
that already knows the answer is yes still has to learn *what the caller may
do*, and `AuthDecision`'s `AuthContext` carried that only for strategies
nobody wrote. Meanwhile `authorizeWsUpgrade` needed exactly that — the scopes
— so it grew its own credential branches instead. A seam that answers the
wrong question is not adopted, and being unadopted is how it stayed wrong.

## Decision

### 1. One resolver answers "what does this credential carry"

A single `CredentialResolver` holds every credential branch. It takes a
presented secret and its carrier-independent context, and answers a **grant**
or `null` — never a status code, never a response.

```ts
export type GrantKind =
  | 'anonymous' | 'daemon-token' | 'oauth-grant'
  | 'pairing' | 'ws-ticket' | 'macaroon'

export interface ResolvedGrant {
  kind: GrantKind
  scopes: readonly AuthScope[]
}

export interface PresentedCredential {
  secret: string
  /** The browser-enforced Origin, when the carrier had one. */
  origin?: string
}

export interface CredentialResolver {
  resolve(presented: PresentedCredential): Promise<ResolvedGrant | null>
}
```

A grant, not a verdict — that is the correction to the seam above, and the
reason this one can be adopted where that one could not.

### 2. A surface owns its carrier, its policy, and its refusal — and nothing else

The three things that genuinely differ stay per-surface, because they really
are different and collapsing them would be the opposite mistake:

- **carrier** — `Authorization: Bearer` on HTTP, a
  `Sec-WebSocket-Protocol` entry on the upgrade;
- **scope policy** — `/api/*` checks the route registry at the gate; the WS
  upgrade checks nothing at the gate because `routes/ws.ts` enforces per
  operation downstream; `/mcp` requires `mcp:call`;
- **refusal shape** — Hono's `c.json({error}, 401)`, a
  `{accept: false, statusCode}` decision, a JSON-RPC `-32000` body,
  and whether a `WWW-Authenticate` challenge is attached.

What moves is only the credential branches. A surface becomes: extract,
resolve, apply policy, shape.

### 3. The resolver is a required argument, built once

Every surface takes `resolver: CredentialResolver` as a **required**
parameter. The composition root builds one from a single config object and
passes the same instance everywhere.

This is the decision that closes the shipped defect, and it closes it by
changing what the omission costs. Today, forgetting one argument silently
removes one credential from one surface. After this:

- forgetting to pass the resolver is a **type error**;
- forgetting a credential *inside* the resolver removes it from **every**
  surface at once — which is loud, and which one end-to-end test catches.

A silent per-surface gap becomes either impossible or obvious. That is the
whole of it.

### 4. `/mcp` gets the resolver too, and the three absences become decisions

`createLocalTokenMcpHttpAuthStrategy` is re-expressed over the resolver with
`requiredScopes: ['mcp:call']` — the same scope server-mode already enforces
there. That is what gives ADR-0043 decision 9 the surface it was aimed at.

The pairing token and the OAuth grant reaching `/mcp` are **not** decided
here. They become entries in the ledger below, each answered on its merits in
its own increment; what this ADR refuses is that they stay unanswered.

### 5. Two executable rungs, because prose is the rung that just failed

Prose already said to wire features up. `userReach` in the dev-loop design
schema already asks the question. Both were in force, and the slice shipped
unwired anyway — so the rungs here are mechanical:

- **A confinement scan** (`tools/arch-lint`): the credential-verification
  primitives — `verifyMacaroon(`, `isAuthorized(`, `.verifyAccessToken(`,
  `.validate(` on a pairing store, `redeemTicket(` — appear **only** inside
  `security/credential-resolver.ts`. A new branch written at a surface fails
  the build. This is the executable form of "the same component", and it is
  what makes the unification hold after the PR that introduces it.
- **A surface ledger** (`auth-surface-coverage.test.ts`), by
  `.claude/rules/coverage-ledger.md`'s scanned variant: every `app.use` with
  an auth middleware and every `authorizeWsUpgrade` call site is found by
  scanning the composition roots, and each is `resolver: <which>` or
  `not resolved: <why>`. Both directions fail. This is the rung that would
  have asked "and `/mcp`?" — the question nobody asked.

Neither rung can be satisfied by a test that hands the credential in itself,
which is the specific way the 39 green tests were satisfiable.

### 6. The unwired seam is replaced, not left beside the replacement

`createLocalTokenAuthStrategy`, `createAuthStrategyMiddleware` and the sync
`AuthStrategy` type are **deleted** in the increment that lands the resolver.
`AUTH_SCOPES`, `ALL_AUTH_SCOPES`, `hasRequiredScopes` and `AuthScope` stay —
they are the vocabulary, they have real callers, and they are not what failed.

The async `AsyncAuthStrategy` that server-mode really uses stays as it is for
now: it is mounted, it works, and folding it in is a second increment with
its own review. Saying so here is the point — an ADR that quietly widened to
both would be the drive-by this repo's vocabulary rule already refuses.

## Consequences

- One place to read to answer "what credentials does this daemon accept". Today
  that answer is assembled from four files and is wrong in the assembling.
- Adding a credential kind is one branch, and it reaches every surface by
  construction rather than by remembering four call sites.
- The cost is a level of indirection at each surface, and a resolver whose
  branch order fixes the verification cost for every surface at once (today
  each surface orders its own; the macaroon is deliberately last on both, so
  the two cheap credentials do not pay for it). The order becomes a single
  decision, which is a small loss of per-surface tuning and a large gain in
  there being one answer.
- The ledger will record real gaps on the day it lands — three of them, in the
  `/mcp` row above. A ledger whose first run is all-green is usually a ledger
  that cannot fail; this one starts by naming what is missing.

## What this does not decide

- Whether the pairing token or an OAuth grant should reach `/mcp`.
- Whether server-mode's `AsyncAuthStrategy` folds into the resolver.
- Anything about ADR-0043's read plane. A content key is not a credential a
  surface checks — that is decision 2's two-planes split, and this ADR is
  entirely inside the act plane.
