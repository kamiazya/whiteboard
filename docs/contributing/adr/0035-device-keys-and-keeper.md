# ADR-0035: A key belongs to a device, and a server keeps rather than vouches

**Status:** Accepted — design of record (2026-09-12); nothing implemented yet. Extends
[ADR-0016](0016-okf-trust-family.md)'s self-report admission and
[ADR-0023](0023-replica-model.md)'s keeper model.

## Context

A workspace is reached from several places — a browser on a PC, a browser on a
phone, the local daemon, a self-hosted server, and later a SaaS. The product
wants those to be one user's, distinguished from each other and kept in sync.
That is an identity question, and DID is the vocabulary usually reached for. This
ADR decides what the identity layer may assume, and — more importantly — what it
may freeze into a document.

### Three vocabularies already answer "who", and two of them are self-reports

| where | shape | cryptographic |
|---|---|---|
| OKF trust family (ADR-0016) | `generated.by` / `verified.by` | no — a declared actor |
| version history | `operatorInfoSchema.actor` (`versions/version-entry.ts`) | no — a declared actor, absent where no device identity exists |
| daemon identity | Ed25519 keypair (`security/daemon-identity.ts`) | **yes — the only one** |

They were invented independently and none references another. ADR-0016's own
Consequences already says what the first one is worth:

> The field is a self-report, and a consumer that treats it as authenticated
> provenance will be wrong.

So the hole an identity layer would fill is documented by the project itself.

*Correction (2026-09-12, same day, while implementing this).* The paragraph
here first said `operatorInfoSchema.peerId` was **not** Loro's peer id, only
a free string with a colliding name. That was wrong, and the truth is worse.
At two of its five call sites the value **was** `doc.peerIdStr` — Loro's own
peer id — which Loro mints fresh on every load of the same document
(measured: three loads of one snapshot, three different numbers). The other
three wrote a per-process nanoid or the literal `'browser'`. So the field
was not one vocabulary with a confusing name; it was three unrelated value
spaces under `z.string().min(1)`, with no row recording which it held. And
nothing read it — the only reads were two tests asserting it was non-blank,
which a random number satisfies. The convergence below therefore begins by
deleting what identified nobody, not by renaming it.

### The synchronisation model is already decided

ADR-0023 fixed it: exactly one keeper per workspace, every other holder a
replica — "readable, overwritten by sync, never authoritative". This is not
multi-master P2P. What an identity layer therefore owes the sync path is *which
replica is this* and *may it push*, not per-operation attribution.

### Two things are absent, and both matter to the reasoning

- **No encryption at rest.** Neither the daemon's SQLite nor the browser's
  IndexedDB encrypts content.
- **No sharing or membership.** Server mode authenticates with JWTs but has no
  per-workspace membership model.

### One lesson is already paid for

The silent-reconnect feature was removed rather than hardened because a
credential in a browser origin's own storage is readable by whatever process
later claims that port — see `docs/explanation/security-model.md`. The
conclusion generalises: **there is no safe way to move a private key between
devices**, so a design that needs to move one is a design that needs a different
shape.

## Decision

Five decisions. The first two constrain what may be written down; the third and
fourth say who signs and who governs; the fifth keeps a later option open at no
cost.

### 1. Signing and authentication keys belong to a device, never to a user

Each keeper and each client holds its own keypair: the daemon (which already
does), each browser profile, each server. A user is the **set of their device
DIDs**, related by a lookup that lives outside the documents.

This is not a preference. A private key cannot be moved between devices safely,
and the repository has already paid to learn it. Every system that solved this
problem — Signal, Matrix, SSH, iCloud Keychain, Bluesky — holds per-device keys
and relates them; none distributes one key to many devices.

**A user-level key is not the opposite of this.** Where one is needed (see
Consequences, E2EE) it does a *different job* — encrypting content — and is
itself wrapped per device. The two coexist; one does not replace the other.

### 2. Only an identifier that survives key rotation may be written into content

A device DID is `did:key:…`, derived from the public key. It cannot rotate,
which is exactly why it is **safe to write into a document**: it will never need
to change.

A user identifier is the opposite. Its whole purpose is to survive a rotated
key, a migrated device, a recovery. Whether it is safe to write down therefore
depends on its method: an identifier that stays fixed while its keys rotate
(the `did:plc` shape) is safe; `did:key` used as a user identity is not, because
losing the device would orphan every record naming it.

**Until a method is chosen, documents and version rows carry the device DID
only** — and where no device identity exists yet (a browser profile), they
carry no actor at all rather than a stand-in. Two places make this load-bearing rather than tidy:

- the OKF trust family, which is stored in its own CRDT bucket and **projected
  to the frontmatter root on serialise** (ADR-0016 decision 4) — so it leaves in
  exported bytes;
- version history rows, which are the record of who saved what.

Both are inside the CRDT, so "fixing" one later is not a migration but a new
operation on every document; and both would sit under a checkpoint signature
(decision 3), which a rewrite would invalidate.

### 3. A signature covers a checkpoint, not an operation

The signed statement is *"this device DID attests that at this frontier the
content hashed to this"*. `packages/history` already holds the checkpoint
scheduler and frontier encoding, so the unit exists.

Signing each CRDT operation is rejected: a merge would invalidate a snapshot
signature, and per-op signatures grow the oplog by more than the operations they
cover. An attestation over a past frontier stays true forever, which is the
property a continuously-merging document needs.

### 4. A server or SaaS is a keeper, not an issuer

What a server is *for* here is sharing and governance — who a workspace is
shared with, and what is deleted when someone leaves. That is authority over a
**resource**, not a claim about an **identity**, and ADR-0023 already assigns it:
the keeper of a workspace is its authority.

An issuer is a different thing. It makes claims about identities and can revoke
them, which makes it a dependency that cannot be removed: "your data survives
the infrastructure dying" stops being true the moment the party that vouches for
you can un-vouch. Sharing and governance carry no such property, because
authority over a resource is scoped to that resource — a dead server costs the
governance of the workspaces it kept, and nothing about who anyone is.

### 5. In the sync path the server stores and orders; it does not interpret

The keeper's role in synchronisation is storage and ordering. Features that read
content — search, thumbnails, export, reference aggregation — stay *outside* the
sync path.

This costs nothing today and is what keeps encryption available later: a CRDT
merges on the client, so a relay never needs to understand an operation. (OT
would need to, which is why OT and end-to-end encryption are fundamentally
opposed — this is a property the project already bought by choosing Loro.)

## Consequences

### What this makes possible now

- The daemon's existing Ed25519 identity generalises instead of being replaced;
  expressing it as `did:key` adds interoperability and changes no key material.
- The three "who" vocabularies gain a single answer to converge on. Converging
  them is the first implementation step, and DID is the notation that rides on
  the result rather than a fourth vocabulary beside them.
- Device migration needs no key transfer at all while content is unencrypted:
  the new device mints its own key and is related to the user by the lookup.

### What is deferred, and what triggers it

**The user DID's method.** Deadline: before 1.0 or the first real user, not
before the first document — `0.0.x` publishes no compatibility promise for
stored shapes (`.claude/rules/vocabulary.md`), so existing data may be discarded
rather than migrated. Until then, only device DIDs are written; a device→user
table is what would allow backfill, and is only needed if backfill is wanted.

**End-to-end encryption.** Trigger: a SaaS — that is, a keeper the user does not
own. There is nothing to defend against while the daemon is the keeper, because
the daemon is the user's own machine. Adopting it would cost the *server-side*
search (`fullTextSearch` / `searchableTexts`), thumbnails
(`document-thumbnail.ts`), SVG/PNG export (`export-svg.ts`), auto-versioning
(`auto-version.ts`) and reference aggregation (`reference-aggregate.ts`) — found
by inspection, not by exhaustive audit. **The MCP tool surface is unaffected**,
because it runs on the daemon.

The interaction with agents is worth stating, because the obvious reading is
wrong: encryption does not mean an agent cannot read, it means only key-holders
can. An agent running on the user's own daemon reads normally. An agent running
on a server whose operator holds the key is not end-to-end encrypted, whatever
the marketing says, and the honest options are to run the agent on the daemon,
or to grant a named agent the key explicitly and say so in the UI. Giving each
agent a DID is what makes that grant enumerable and revocable.

The hard part is not the encryption — it is rotating a group key when someone is
removed. MLS (RFC 9420) is the standard answer; hand-rolling it is not advised.

**Issuing verifiable credentials.** Trigger: sharing between daemons, where one
daemon must trust a claim another party made about a user it has never met. A
server gating its own resources needs ordinary authorization, not a credential —
including for paid plans. Adopting it accepts the dependency described in
decision 4.

### What gets harder

- **Attribution depends on a lookup.** A document naming `did:key:z6Mk…` says
  nothing to a human without the device→user table. Losing that table loses
  attribution, permanently, for records already written. The alternatives are to
  snapshot a display name beside the device DID (self-contained, but it ages and
  puts personal data into exported files) or to write the user DID once its
  method is fixed.
- **Sharing and membership are new design**, not an extension of something
  present. Decision 4 says where the authority sits, not how it is modelled.
- **Decision 5 is a prose rule.** Nothing mechanical stops a future feature from
  teaching the sync path to interpret content; the cost of that mistake is only
  visible when encryption is attempted.

## Alternatives considered

**One user key, carried between devices — with a passkey moving it.** Rejected,
and the mechanism does not exist as assumed: WebAuthn has no API that exports key
material, and a synced passkey syncs *itself*, not an application's key. What is
possible is the `prf` extension, which derives a stable value usable as a
*wrapping* key — so a user key can be **wrapped and fetched**, never moved. That
is a mechanism for decision 2's deferred E2EE case, not a replacement for
per-device keys, and it carries its own dependency: the passkey provider becomes
the recovery path, which relocates the recovery problem rather than solving it.
Support for `prf` is uneven and must be verified against the target platforms
before anything is built on it.

**Never writing a user DID into content.** This was the first formulation and it
is too strong. What must not be frozen is a *mutable* identifier; an identifier
that stays fixed across key rotation is safe, so a `did:plc`-shaped choice would
make writing it correct. Stating the rule as "no user DID" would leave a
needless constraint behind once a method is chosen — hence decision 2's wording.

**Making the server an issuer, so that "who is this user" has one answer.**
Rejected for the reason in decision 4: it converts a removable dependency into an
unremovable one, and it answers a question the product does not actually ask.
Sharing and governance are authority over resources, which the keeper already
holds.

**`did:plc` for the user identity, adopted now.** Deferred rather than rejected.
Its design is the right shape — a self-certifying genesis operation, rotation
keys in priority order, and a signed operation log — and that shape can be
borrowed without adopting the method. But `plc` abbreviates *placeholder*, its
authors treat it as an interim solution, and resolution in practice goes through
one directory operated by Bluesky. Using it removes the burden of running the
infrastructure and does not remove the dependency, which a product claiming
survivability should decide deliberately rather than inherit. (Operational facts
here were current as of 2026-05 and need re-checking before adoption.)

**Signing each CRDT operation, so authorship is attributable at any
granularity.** Rejected in decision 3. It is the design multi-master P2P would
need, and ADR-0023 already decided this system is not that.
