# ADR-0043: Authority is a key, delegation derives a narrower one, and revocation is declining to hand out the next

**Status:** Proposed — design of record; nothing implemented. Gives
[ADR-0041](0041-profile-and-authority.md)'s "authority" and
[ADR-0042](0042-offline-revocation.md)'s content key one mechanism, and brings
the attenuation [ADR-0005](0005-hosted-origin-authorization.md) built for
hosted origins to the local-daemon mode it deliberately left unscoped. Stands
on [ADR-0035](0035-device-keys-and-keeper.md) decision 1 **and its 2026-09-16
addendum** — the addendum decides the format survey in decision 7, and
decision 1's own "a user-level key does a different job" is decision 2 here.

## Context

ADR-0041 and ADR-0042 use the word *authority* throughout and never say what
it is that somebody **holds**. That gap is why each new seam re-derives the
reasoning, and why the same word covers things with very different strengths.

### The first draft of this ADR was the wrong shape, and the mistake is worth keeping

It audited the four places the codebase already reasons in capabilities,
stated four invariants, and **deliberately chose no mechanism and no token
format** — on the argument that the differentiators answer questions nobody
had asked. The owner's correction: what was wanted was a model of authority
*delegated by cryptographic keys*, because that is what makes the concept
legible, and a document with no mechanism is one nothing can fail against.

The draft's own closing paragraph had already said so ("an ADR with no
mechanism is an ADR nothing can fail against. Its only rung is review"). It is
worth recording that a document can name its own defect accurately and still
ship with it.

The four invariants survive unchanged as decision 8. Everything else here is
new.

### What the codebase already holds, read rather than recalled

| fact | where | consequence |
|---|---|---|
| the daemon has an Ed25519 keypair and a `did:key` name for it | `security/daemon-identity.ts`, `api-contracts/did-key.ts` | "what key does the issuer sign with" is already answered |
| `jose` is already a dependency | `packages/mcp-server/package.json` | JOSE primitives need no new dependency |
| the browser holds **no** private key, by a deliberate removal | `browser-idb.ts` v5 → v6 deletes `reconnectKeypairs` | the browser cannot be a signing principal |
| the browser CAN verify Ed25519 | `daemon-identity-pin.ts` (`crypto.subtle.verify`) | moving to public-key signatures later costs nothing browser-side |
| eleven scopes and a route registry exist | `route-scope-registry.ts`, `auth-strategy.ts` | the vocabulary to attenuate *to* is already written |
| one credential is already attenuated end to end | `auth.ts` (`hasRequiredScopes`), `ws-auth.ts` (`redeemed.scopes`) | attenuation is an existing shape here, not a new one |
| the other two are not | daemon token and pairing token: no scope check on HTTP, `ALL_AUTH_SCOPES` on a websocket upgrade | this is what decision 9 narrows |
| issuer and verifier are the same process in local-daemon mode | `app.ts`, `server-mode-http.ts` | a symmetric-key scheme's usual weakness does not apply |

The two credential rows are worth separating, because a summary flattens them
and the flattened version is wrong. An **OAuth grant** is scope-checked on HTTP by
`isAuthorizedOAuthGrant` → `hasRequiredScopes`, and an accepted websocket
upgrade through its connection ticket carries `redeemed.scopes` — exactly what
the grant held, never `ALL_AUTH_SCOPES`, as `ws-auth.ts` says in so many
words. That path already implements everything decision 4 asks for. The
**daemon token** and the **pairing token** do not: neither is scope-checked on
HTTP (`createLocalTokenAuthStrategy` ignores `requiredScopes` by a stated
single-tenant concession; `isAuthorizedPairingOrigin` returns a bare boolean
and the middleware calls `next()`), and both yield `ALL_AUTH_SCOPES` on a
websocket upgrade. The pairing token is the sharper case: ADR-0005 made it
narrow on the axes it designed for — bound to one origin, expiring — and it
is unnarrowed on the scope axis.

So this ADR is not introducing attenuation to the codebase. It is asking why
the credential an agent actually uses is the one that does not have it.

The row about the browser's keypair is the one that decides decision 7. `browser-idb.ts` removed the
keypair store because a non-extractable key sitting beside the content can be
invoked by whatever script can also rewrite the content — ADR-0035 decision
1's 2026-09-16 addendum generalises it. Any scheme that requires the *audience*
of a delegation to hold a durable signing key is therefore asking this project
to reverse a decision it has already paid for.

### What capabilities are not for here

ADR-0041 separated what a keeper may do with a **resource** from what anyone
may claim about an **identity**. Everything in this ADR is the first. A
version row's actor is not an authorisation input, and nothing here unblocks
or depends on the user DID method.

## Decision

### 1. Authority is the possession of a key

A holder may do a thing because it holds something, not because it is
recognised. Delegation is deriving a narrower key from a wider one and handing
the derived one over. Revocation is declining to hand out the next one.

That single sentence is meant to cover ADR-0041's L1 and L2, ADR-0042's
content key, and what an agent holds. Where it does not cover something, say
so rather than stretching it — decision 2 is the first place it does not.

### 2. There are two planes, and they are not equally strong

| | what the key is | who stops an unauthorised read or write | broken by |
|---|---|---|---|
| **act** | a token the daemon checks | the daemon's own code | a bug in that code |
| **read** | a content-decryption key | arithmetic | nothing short of the key leaking |

The act plane is enforcement: the daemon holds the plaintext, so a token that
gets past the check gets everything the check was guarding. The read plane is
cryptography: a holder without the key has ciphertext, whatever it does with
its disk, and whether or not it is online.

The split is not new here. ADR-0035 decision 1 already draws it — a signing
key belongs to a device, and "a user-level key is not the opposite of this
… it does a *different job* — encrypting content". This ADR names the two
jobs *authority* and puts them on one model without claiming they are one
mechanism.

It is stated as a decision rather than a note because collapsing it is the
predictable failure of this ADR. "Keys are the authority model" reads as if
both planes had the strength of the second, and **ADR-0042's claim that
revocation is cryptographic rather than advisory is true only of the read
plane.**

### 3. Read authority attenuates by key derivation

ADR-0042's per-workspace content key becomes the **root of a derivation tree
rather than the key the bytes are under**. This amends ADR-0042 decision 2,
which says a replica is ciphertext under the per-workspace key: a document's
ciphertext is under its own derived key, and the workspace key is what that
key is derived from. Without this, a holder given a document key holds
something that opens nothing, and document-level delegation is a sentence with
no mechanism behind it.

The derivation is specified rather than sketched, because two implementations
that disagree about the encoding derive different keys and the failure is
silent:

```
documentKey = HKDF-Expand(
  PRK  = HKDF-Extract(salt = workspaceKeySalt, IKM = workspaceKey),
  info = utf8(JSON.stringify(["wb-doc-key-v1", documentId, epoch])),
  L    = 32,
)                                          // HMAC-SHA-256 throughout
```

- **SHA-256**, and 32 bytes out, matching the AES-256-GCM the content is under.
- **Extract and expand are separate** ([RFC 5869](https://datatracker.ietf.org/doc/html/rfc5869)).
  `workspaceKeySalt` is a per-workspace random salt stored beside the
  ciphertext; it is not a secret and does not travel with the key.
- **`info` is domain-separated and unambiguously encoded** — the JSON-array
  form `daemon-identity.ts`'s `buildSignedPayload` already uses here, so
  `["a","bc"]` and `["ab","c"]` cannot collide. A bare concatenation of an id
  and an epoch is exactly the ambiguity that trick exists to remove.

A holder given `documentKey` can read that document and cannot compute the
workspace key or a sibling's, because HKDF does not invert. Attenuation here
is **arithmetic, not a rule somebody enforces** — which is the whole reason to
prefer it to a policy field.

Everything else ADR-0042 decided is unchanged: the key still arrives from the
network per session and still lives in memory only. A derived key is subject
to the same rule; persisting one at any level collapses that level back to the
advisory case.

**`epoch` is what makes revocation affordable, and it is the reason the term
is in the `info` string at all.** Derivation makes delegation cheap and
revocation expensive: a derived key cannot be un-derived, so taking it back
means changing one of its inputs. Without an epoch the only input available is
`workspaceKey`, and rotating that changes **every sibling document key and
requires the whole workspace to be re-encrypted** — a cost out of all
proportion to withdrawing one document from one holder. Bumping a single
document's epoch re-keys that document alone.

What that costs, said plainly rather than left for the implementation to
discover: the epoch is stored per document beside its ciphertext, and bumping
it means re-encrypting **that document**. Workspace-wide rotation remains
available and remains workspace-wide; it is the right move when the workspace
key itself is suspect, and the wrong one for an ordinary revocation. ADR-0042
decision 5 bounds what is handed out in the first place — a session on the
`offline` tier, a TTL lease on `bounded` — so an expiry usually settles this
before any rotation is needed.

### 4. Act authority attenuates by an HMAC chain — the macaroon model

A token carries a chain of caveats, each folded into the signature:

```
sig₀ = HMAC(rootKey, tokenId)
sigᵢ = HMAC(sigᵢ₋₁, caveatᵢ)
```

Adding a caveat is cheap and needs nobody's permission. Removing one requires
`sigᵢ₋₁`, which HMAC does not yield, so **a holder can only narrow what it
holds** — the same one-wayness as decision 3, over a different thing. This is
the construction from [Macaroons](https://theory.stanford.edu/~ataly/Papers/macaroons.pdf)
(NDSS 2014).

Caveats are **Zod-schema'd predicates, not a policy language**. A macaroon's
first-party caveats are opaque to the format and interpreted by the verifier,
so this is the format's own design rather than a deviation from it, and it
keeps one schema language in the codebase.

**An issued token works until it expires, and that is a cost rather than a
detail.** This is capability security's known weakness and the withdrawn draft
was right to state it: the daemon cannot reach into a holder and take a token
back, so decision 1's "declining to hand out the next one" is only as prompt
as the lifetime of the last one.

Say precisely which half of that is unavailable, because the loose version is
wrong: **a token's validity is verifiable offline** — the chain checks against
the root key with no network — and what is not is **whether a still-valid
token has been revoked since it was issued**. Revocation enforcement, not
verification, is what waits for a connection. An enterprise revocation
requirement is therefore priced against the reissue interval, not against a
signature.

The standard mitigation is the one ADR-0042 already took on the read plane:
short lifetimes, reissued on connect. A deny-list is the alternative and is
deliberately not chosen here — it reintroduces the lookup decision 1 exists to
avoid, and a list that must be consulted on every request is an ACL wearing a
capability's clothes.

The two planes differ here too, and in the direction that matters: a withheld
content key stops a holder that never reconnects, while an unexpired token
does not. **Where a revocation must bite an offline holder, it is ADR-0042's
mechanism that bites, not this one.**

### 5. Implement it here rather than importing it

The construction is HMAC-SHA256 and nothing else. `crypto.subtle.sign('HMAC',
…)` exists on Node, in the browser and on Workers, so a native implementation
takes no dependency and passes the shared-layer rule in
`.claude/rules/architecture-map.md` by construction rather than by review.

Three things make this a smaller risk than "rolling your own crypto" usually
is, and they are the conditions under which it stays acceptable:

- there is no novel construction and no asymmetric arithmetic;
- `daemon-identity.ts`'s `buildSignedPayload` already solves the adjacent
  trap (unambiguous part boundaries via JSON-array encoding) and is the
  pattern to follow;
- the CONSTRUCTION is checked against the reference rather than against
  itself. [libmacaroons](https://github.com/rescrv/libmacaroons)' README
  worked example is a known-answer test for the chain, and the same values
  appear in at least six independent implementations (C, Java, JavaScript,
  C#, Python, Erlang), so reproducing them is independent implementations
  agreeing rather than this one agreeing with itself.

  **Construction and serialization are separate, and only the first is
  checked.** libmacaroons' `macaroon-test-serialization.c` vectors are the
  second kind — one macaroon in its V1 and V2 wire formats — and cannot
  match a module that serializes to its own JSON. That costs only
  interoperability, which a single-issuer single-verifier daemon does not
  need. This distinction is recorded because the first draft of this ADR
  cited "libmacaroons publishes test vectors" without saying which, and the
  implementation then found the cited vectors were the ones that do not
  apply — followed by a second error, concluding from that that no external
  check was available at all.

If any of those stops being true, decision 6 applies instead.

### 6. Biscuit is the named upgrade, and here is what triggers it

[Biscuit](https://www.biscuitsec.org/docs/help/faq/) is the same model with
Ed25519 signatures in place of the HMAC chain, plus a Datalog policy language
and externally signed third-party blocks. It is the right destination on
either of two triggers:

- **a verifier that must not be able to mint.** HMAC's one real weakness is
  that verifying and forging need the same key. Today issuer and verifier are
  the same process, so the weakness is unreachable; a verifier that cannot be
  handed the root key makes it reachable, and public-key signing is the answer.
- **a third party in a caveat** — "the organisation's IdP says yes". Writing
  discharge or third-party-block machinery by hand is not worth it.

Neither has happened. Until one does, the cost is real and one-directional:
`@biscuit-auth/biscuit-wasm` is a WebAssembly build of a Rust library, which
collides with the shared layer's "runs unchanged on Node, the browser and a
Worker" criterion and with the published `@kamiazya/whiteboard-mcp` bundle
(the reason BudouX is vendored rather than depended on), and Datalog would be
a second policy language beside Zod.

### 7. UCAN and ZCAP-LD are rejected on a fact, not on taste

Both require the **audience** of a delegation to hold a signing keypair —
[UCAN](https://github.com/ucan-wg/spec) v1.0.0 identifies principals by
`did:key` and needs the delegate to sign its invocation; ZCAP-LD's invocation
is a separately signed document. The browser deliberately holds no private key
(the Context row about `reconnectKeypairs`), so adopting either means
reversing that decision or
minting a per-session key in memory and inheriting a cold-start problem on top
of ADR-0042's.

Two further reasons, in descending weight:

- UCAN roots authority in the **user**; this project roots it in **resource
  ownership** — ADR-0035 decision 4's "authority over a resource, not a claim
  about an identity", which ADR-0041 decision 3 turns into L1/L2 and decision
  6 applies to the right to leave. Adopting a model whose direction is the
  opposite of the one just decided would make both harder to read.
- [ZCAP-LD](https://w3c-ccg.github.io/zcap-spec/) is a W3C CCG work item at
  v0.4.0-rc, not a Recommendation, and brings JSON-LD contexts and Data
  Integrity proofs to a daemon on loopback.

Recorded so a later reader does not re-survey them. Both are good designs for
a problem this project does not have.

### 8. The four invariants

Carried unchanged from the withdrawn draft; they are what any future mechanism
is judged against.

They keep the field's word, **capability**, rather than this ADR's, so that a
reader can match them against the literature. The two are the same thing at
different altitudes: a capability is the general notion, and in this codebase
it is always a key — a macaroon on the act plane, a derived content key on the
read plane. Nothing is a capability here that is not one of those two.

1. **No ambient authority.** Authority arrives with the request, in something
   the caller holds. A caller does not acquire an access by being recognised.
2. **Attenuation is one-way.** Anything derived from a capability is narrower
   or equal, never wider. Decisions 3 and 4 make this arithmetic on both
   planes rather than a review rule.
3. **Revocation is the issuer declining to reissue**, not reaching into a
   holder.
4. **A capability is not an identity.** It says what may be done, never by
   whom. Audit reads identity; authorisation reads the capability.

The generalisation of `route-scope-registry.ts`'s `daemon-token-only` comment
follows from 2 and is worth stating on its own, because it is the rule a new
route is judged against: **no route may be a path from a narrow credential to
a wider one.** A route that hands out authority must require the authority it
hands out.

Today's unscoped daemon and pairing tokens do not violate it — nothing widens,
because nothing was narrow to begin with. That is the weaker failure and the
one decision 9 addresses: an invariant about not widening says nothing at all
when every credential starts at the top.

### 9. Two first applications, in no fixed order

Both are named because leaving the first application unstated is what left the
withdrawn draft unapplied. Which is built first is a sequencing decision, not
one this ADR makes.

- **What an agent holds.** An agent reaching the daemon carries the daemon
  token, and there is no narrower thing to give it: no scope is checked on
  HTTP, and a websocket upgrade carries `ALL_AUTH_SCOPES` — `runtime:admin`
  and `mcp:call` included. The human operating it holds the same thing, so a
  prompt that persuades the agent reaches everything the human can reach: a
  confused deputy in the classic shape. ADR-0039 decision 4's human gesture is
  evidence *after* the reach exists; decision 4 here narrows the reach.

  What this asks for is not new machinery but **the OAuth grant path's
  attenuation, on the credential an agent actually uses**. Narrowing it means
  undoing part of a concession that was made knowingly, so it is a behaviour
  change with its own increment — and the pairing token, unnarrowed on the
  scope axis for the same reason, comes with it.
- **The content-key tree.** Decision 3 over ADR-0042's per-workspace key.
  Smaller, and on the stronger plane.

## Consequences

### What this makes possible

- One sentence covers ADR-0041's L1/L2, ADR-0042's content key and an agent's
  reach, so the next seam is designed against a model rather than re-derived.
- An agent can be given something narrower than its operator holds, which is
  not expressible today.
- A holder can attenuate **without a round trip**, so an agent spawning a
  sub-agent hands down a narrower token rather than its own.
- The read plane's attenuation is checkable by construction: a test can assert
  that a derived key cannot open a sibling, which no policy field admits.

### What is deferred, and what triggers it

- **Which application is built first** — decision 9, deliberately open.
- **Whether local-daemon mode enforces scopes at all.** The concession was
  made knowingly; undoing it is a behaviour change with its own increment.
- **Biscuit** — decision 6's two triggers.
- **Cold-start for a derived key** rides ADR-0042 decision 6's `prf` wrapping
  unchanged; nothing here changes that trigger.

### What gets harder

- **Two planes is one more distinction to keep straight**, and decision 2 is
  the one a summary will flatten. Any copy, log line or doc that says
  "cryptographically revoked" has to mean the read plane.
- **Act-plane revocation is bounded by a token lifetime**, so "revoked"
  in an administrator's UI means "will stop working within N", and the copy
  has to say which N rather than implying immediacy.
- **A key persisted "for convenience" at any level of the derivation tree
  leaves every test green and the guarantee gone.** ADR-0042 already named
  this for the root; a tree multiplies the places it can happen. This wants an
  executable guard, not a prose rule.
- **Revocation on the read plane costs a rotation** of whatever level was
  delegated. Bounded by decision 3's time limit, not removed by it.
- **This is cryptographic code in a repository that has very little.** The
  mitigations in decision 5 are conditions, not reassurances; if the
  implementation grows past an HMAC chain, it has outgrown decision 5.

## Alternatives considered

**An opaque token plus a server-side grant record.** What the withdrawn draft
chose. It satisfies every invariant, needs no cryptographic code, and revokes
instantly by deleting a row. Rejected on the ground the owner named: the point
of this increment is that the concept of authority be legible, and "the key
you hold *is* the permission" explains itself where "a random string the
server happens to have a row for" does not. The usual argument against it —
that attenuation needs a round trip — does not apply here, since the daemon is
on loopback.

**Adopt Biscuit now.** Rejected in decision 6: a WASM dependency and a second
policy language, bought against two triggers that have not fired. Its
advantages are real and the migration is named rather than foreclosed.

**Adopt UCAN or ZCAP-LD.** Rejected in decision 7 on a measured repository
fact, not a preference.

**Keep the vocabulary ADR and put the mechanism in a separate one.** Rejected:
the withdrawn draft is the evidence. A document whose only rung is review is
one that gets cited approvingly and applied nowhere.

**Treat the content key and the act token as one mechanism.** Rejected in
decision 2. They are both keys and both attenuate one-way, which is exactly
what makes the conflation tempting; they fail differently, and a model that
hides that overstates the weaker one.
