# ADR-0043: Authority is held, attenuates one way, and never widens by being passed on

**Status:** Proposed — vocabulary and invariants only. **No mechanism and no
token format are chosen here**, deliberately (see decision 7). Names what
[ADR-0005](0005-hosted-origin-authorization.md),
[ADR-0041](0041-profile-and-authority.md),
[ADR-0042](0042-offline-revocation.md) and the existing
`route-scope-registry.ts` are already doing, so the next seam is designed
rather than improvised.

## Context

This ADR introduces almost nothing. Its case is that the codebase **already
reasons in capabilities in four places and has never used the word**, so each
new seam re-derives the reasoning from scratch and the derivation is not
always the same.

### What is already a capability, read rather than recalled

| where | the held thing | what holding it grants |
|---|---|---|
| `security/route-scope-registry.ts` + `auth-strategy.ts` | an OAuth access token's granted `AuthScope[]` | the routes whose declared scopes it covers, conjunctively |
| pairing (`api-contracts/pairing.ts`) | a token with an `origin` and an `expiresAt` | reaching the daemon from that origin, until it expires |
| ADR-0042 | a per-workspace content key held in memory | reading that workspace's replica |
| ADR-0005 | the bootstrap token, whose carriers are restricted to two channels | the daemon, from a page that received it |

The clearest case is a comment that already makes the argument in full.
`route-scope-registry.ts` keeps a `daemon-token-only` decision alive for a
route that does not currently exist, because:

> a scope-limited hosted-origin grant that could reach such a route would let
> itself **mint a path back to the full, unscoped daemon token, escaping the
> very scopes it was approved for**

That is attenuation and privilege escalation, stated exactly. Nothing in this
ADR improves on it; what this ADR does is make it a **rule the next route is
judged against** rather than a comment on one that was never built.

### Where the model stops today, by a stated decision

`createLocalTokenAuthStrategy`'s success path **ignores `requiredScopes`
entirely**, and says so:

> Local-token is a single-tenant concession; scope enforcement lives in
> server-mode strategies

So the scope vocabulary — eleven scopes, conjunctive, with a registry test
that walks every mounted route — is live in server mode and inert in
local-daemon mode. That is a recorded trade, not an oversight, and this ADR
does not overturn it. It records the consequence, which is sharper now than
when the concession was made: **this product's local-daemon mode is how an AI
agent reaches the daemon**, and a single-tenant concession sized for one
human at one browser now also sizes what an agent holds.

### What capabilities are not for here

ADR-0041 separated two questions: what a keeper may do with a **resource**,
and what anyone may claim about an **identity**. Capabilities belong entirely
to the first. Attribution, the History row's name, and an audit trail are
identity, and a capability deliberately says nothing about who holds it.

## Decision

### 1. The word, and what it names

A **capability** is a thing whose possession grants an access, without any
further lookup of who the holder is. A scope set on a token, a content key, a
pairing token bound to an origin — each is one.

This is a vocabulary decision, so its test is whether a reader can classify a
credential. Anything that answers "may this caller do X?" by consulting a
table keyed on the caller's identity is **not** a capability, and naming it
one is the error this ADR is meant to prevent.

### 2. The four invariants

1. **No ambient authority.** Authority arrives with the request, in something
   the caller holds. A caller does not acquire an access by being recognised.
2. **Attenuation is one-way.** Anything derived from a capability is narrower
   or equal, never wider.
3. **Revocation is the issuer declining to reissue**, not reaching into a
   holder. This is what ADR-0042 already does with the content key.
4. **A capability is not an identity.** It says what may be done, never by
   whom. Audit reads identity; authorisation reads the capability.

### 3. No route may be a path from a narrow credential to a wider one

The generalisation of `route-scope-registry.ts`'s `daemon-token-only`
decision, promoted from a comment about one hypothetical route to the rule
every new route is judged against: a route that hands out authority must
require the authority it hands out.

This is where the registry's existing shape earns its keep — an undeclared
route resolves to `null` and the caller fails closed, rather than inheriting
a guess.

### 4. Identity and capability stay in separate planes

ADR-0041's two axes, restated at the mechanism level: the profile plane
answers *who*, the capability plane answers *may*. A surface that needs both
asks both. Neither is derived from the other.

The practical rule: **a version row's actor is not an authorisation input,
and a capability is never written into content.**

### 5. Revocation needs an online check, and that is a cost, not a detail

A capability, once held, works until it expires or the issuer stops honouring
it — this is capability security's known weakness and the project should say
so rather than discover it. ADR-0042 already took the standard mitigation
(short-lived, reissued on connect), which means **authority is not
offline-verifiable** in this system.

Stated here so no later reading of ADR-0042 promises otherwise, and so that
an enterprise revocation requirement is priced against the reissue interval
rather than against a token's signature.

### 6. The first application is what an agent holds

An agent reaching the daemon today holds the local token, which per the
concession above carries `ALL_AUTH_SCOPES` — `canvas:write`,
`workspace:write`, `files:write`, `runtime:admin`, `mcp:call`. The human
operating it holds the same. There is no narrower thing to give it.

That is a confused deputy in the classic shape: the agent acts with the
human's full authority, so a prompt that persuades it to act reaches
everything the human can reach. ADR-0039 decision 4 already asks for a human
gesture where "was that really the person?" has a cost; that is evidence
*after* the reach exists, and a capability narrows the reach itself.

**What is decided here is only that this is the first place to apply the
vocabulary.** What an agent's capability is scoped to — a workspace, a
document, a session — is a design, not a rename, and it is the next ADR.

### 7. No token format is chosen, and here is what would choose one

Macaroons, biscuits, UCAN and ZCAP all implement decision 2, and they differ
on questions this project has not answered. The format follows the answers:

| question | if yes | if no |
|---|---|---|
| must a holder attenuate **offline**, without the issuer? | a format with in-token caveats | an opaque token plus a server-side grant record is enough |
| must a **third party** be named in a caveat? | macaroon-style third-party caveats | no |
| must a capability be verifiable by someone **other than the issuer**? | a signed, self-describing format | the issuer verifies its own, and simplest wins |

Today all three answers look like "no", and an opaque token with a
server-side record satisfies every invariant above. Recording that here
prevents the format being chosen by whichever library someone reaches for at
the moment the first narrow credential is needed.

## Consequences

### What this makes possible

- A new route or credential is judged against four invariants instead of
  being reasoned out again.
- The local-token concession becomes a **stated boundary of the model** with
  a named consequence, rather than a comment in one file.
- Agent scoping has somewhere to start from.

### What is deferred, and what triggers it

- **What an agent's capability is scoped to** — the next ADR, and the reason
  this one exists.
- **A token format** — decision 7's table, triggered by the first "yes".
- **Whether local-daemon mode should enforce scopes at all** — a real
  question this ADR deliberately does not answer, because the concession was
  made knowingly and undoing it is a behaviour change, not a vocabulary one.

### What gets harder

- A fifth word in a space that already has scope, grant, token, and pin. The
  register in Context is the mitigation: if a reader cannot place a
  credential in it, the vocabulary has failed and should be fixed rather than
  worked around.
- An ADR with no mechanism is an ADR nothing can fail against. Its only rung
  is review, and a vocabulary nobody applies is worse than none — the honest
  test is whether the next route's design cites it.

## Alternatives considered

**Adopt a capability system wholesale, with a token format.** Rejected as
architecture ahead of a requirement: every invariant above is satisfiable
with what exists, and the format's differentiators answer questions nobody
has asked yet.

**Do nothing; the comments are enough.** Rejected because the reasoning is
already duplicated across four places and is not identical in each, and
because the local-token consequence is invisible from any one of them.

**Fold this into ADR-0041.** Rejected: 0041 is about identity and its
authority, and the two planes staying separate is a decision this ADR makes.
Putting them in one document argues the opposite.
