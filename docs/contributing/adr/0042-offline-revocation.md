# ADR-0042: An offline policy decides whether a replica exists, and revocation withholds its key

**Status:** Accepted — human gate 2026-09-19, in effect since 2026-09-21.
Decisions 1, 2, 3 and 5 are implemented end to end: the daemon's
`POST /api/workspaces/:id/replica-key` route enforces the per-workspace tier
and issues a `bounded` lease's timestamp, and every production
`DocumentStore` construction in `apps/web` goes through one factory
(`replica-store.ts`'s `openDocumentStore`) that seals a daemon-kept
workspace's IndexedDB chunks under the session key it holds in memory only,
while a browser-kept workspace stays plaintext as it always did (see
[`docs/explanation/security-model.md`](../../explanation/security-model.md)).
Split out of [ADR-0041](0041-profile-and-authority.md), which decides
profiles and authority. Constrains [ADR-0023](0023-replica-model.md)
decision 2's offline-readable replica with an organisation policy, and makes
the revocation cryptographic rather than advisory. Decision 6,
cold-start-offline, **shipped 2026-09-21** on the shared gesture it names —
[ADR-0039](0039-passkey-attestation.md) decision 6's user-verification gate.

## Context

ADR-0041 decision 3 gives a keeper L1 (access to a resource) and L2
(acceptance of a credential). Both are a state change at the keeper, and
neither reaches a holder that is not listening. ADR-0023 decision 2 makes a
replica readable while the keeper is unreachable — a feature, and the
obstacle.

### Two earlier framings of this were wrong, in opposite directions

**The first** offered a lease with a TTL and declined to choose, pending
deployment evidence. **The second** rejected the lease outright and kept only
"cache or do not cache", on the ground that a lease over a plaintext store is
advisory: `docs/explanation/security-model.md` records that a browser keeper's
IndexedDB content "remain[s] readable by whatever later owns the origin", with
"no equivalent fix available", so an expired lease is the *application*
declining to render bytes still on the disk.

That reasoning was sound and its conclusion was too narrow, because it assumed
the only thing an expiry could take away was **the data**. The owner's
correction: expire the **key** instead. A replica whose bytes are ciphertext
is useless to a revoked holder without anything being deleted, and a
reconnection that restores authorisation restores the key rather than
re-downloading the workspace.

That also corrects a claim the second framing made: that a bounded tier waits
on ADR-0035's deferred E2EE. It does not, and the two are different problems.

| | who is kept out | what it costs |
|---|---|---|
| E2EE (ADR-0035, deferred) | **the keeper itself** | user-held keys, per-device wrapping, a recovery story |
| encryption at rest under a keeper-held key | anyone holding the replica **without the keeper's cooperation** | one key per workspace |

The keeper already holds the plaintext — it is the keeper. Encrypting the
replica hides nothing from it and is far cheaper than E2EE, while being
exactly the mechanism revocation needs.

### The lesson about where a key may live is already paid for

`browser-idb.ts`'s v5 → v6 migration deleted the `reconnectKeypairs` store
because, as ADR-0039 puts it, a key beside the content can be invoked by
whoever can also rewrite the content. The same applies here and is the single
implementation trap: **a content key persisted in IndexedDB collapses this
design back to the advisory case.** The key comes from the network, per
session, and lives in memory.

## Decision

### 1. The policy chooses whether a replica exists

An organisation states, per workspace and defaulting from an organisation-wide
setting, whether its workspaces may be replicated to a client at all. This is
the shape Google Workspace uses for offline access — an administrator turns it
on or off for a group — and it is a question an administrator can answer,
where "what is the correct TTL in hours?" is not.

### 2. A replica is encrypted at rest, under a key the keeper holds

Where a replica exists, what is written to IndexedDB is ciphertext under a
per-workspace content key. The client receives that key on authorising and
holds it **in memory only** — never in a store, for the reason above.

[ADR-0043](0043-authority-as-keys.md) decision 3 **amends the sentence above**:
this key is the root of an HKDF derivation tree rather than the key the bytes
are under, and a document's ciphertext is under its own derived key. That is
what lets a holder be given one document rather than the workspace; under a
single workspace-wide key, a document key would open nothing. The in-memory
rule applies unchanged at every level of the tree, and 0043 specifies the
derivation's parameters and its per-document `epoch`, which is what keeps
revoking one document from re-keying the whole workspace.

### 3. Revocation withholds the key; that is the whole mechanism

A revoked client reconnects, is refused the key, and its replica is ciphertext
from then on. Nothing has to be deleted for the guarantee to hold, and nothing
has to be re-downloaded when access continues.

**Deleting the local replica is therefore housekeeping, not security.** A
client may free the space, and an honest one will, but the guarantee does not
rest on it — which is the honest version of a claim the previous framing had
to hedge as "best-effort".

Not deleting has a second benefit worth stating, because it is the case an
administrator will meet: **a revocation reversed by mistake costs nothing**.
Restoring access restores the key, and the replica is readable again.

### 4. Un-merged offline edits are discarded with everything else

A person revoked while disconnected reconnects carrying edits. They are not
merged, and **no export path is offered**.

They are edits to a document the organisation owns, made after it decided that
person should stop contributing; handing them back would reopen the route the
revocation just closed. An earlier draft proposed a one-time export key on the
reasoning that a person should not lose their work — the owner rejected it,
and correctly: the work is not the person's to take.

No deletion step is needed here either. The edits sit under the same withheld
key as the rest of the replica.

The person is still **told**, because silence would be read as a bug rather
than a decision: *removed from this workspace; changes made since then were
not sent.* That is honesty about what happened, not a copy of the content.

### 5. Three tiers

| tier | replica | revocation takes effect | offline work |
|---|---|---|---|
| **no-offline** | not created | immediately, by construction | none |
| **offline** (default) | encrypted, key per session | at the next reconnect | within a session that began online |
| **bounded** | encrypted, key leased with a TTL | at reconnect, or at lapse | until the lease lapses |

All three are buildable. `no-offline` remains the only one whose guarantee
holds without any assumption about the client, since there is nothing on the
disk at all; `offline` and `bounded` rest on the key never being persisted
**in the clear** — decision 6 persists it wrapped, under material that lives
only inside an authenticator, which is what keeps the guarantee while making
a cold start possible.

### 6. Cold-start offline is the passkey's own gesture (shipped 2026-09-21)

A key held in memory is gone when the tab closes, so reopening offline finds
ciphertext and no key. Making that work means persisting the key **wrapped by
something not stored beside it** — WebAuthn's `prf` extension, which ADR-0035
names as a wrapping mechanism and which unwraps without a network.

Written as deferred, and then built, because the reason to wait turned out to
be thinner than ADR-0035 suggests: that ADR called `prf` support uneven, and
ADR-0039's own measurement of 2026-09-13 found it **broadly available on
platform authenticators** (Safari 18+ and macOS 15, Firefox 139+, Chrome 147
on Windows). The remaining cost is the one ADR-0035 names and this ADR does
not solve, and it is accepted knowingly (user decision, 2026-09-21): **the
passkey provider becomes the recovery path.** The UI says so on the screen
that offers the unlock.

It IS the **same gesture** as ADR-0039 decision 6's user-verification gate:
unlocking a workspace and obtaining its key are one action, not two prompts
for the same intent. Concretely, the session-assert assertion that binds a
pairing session to a person carries the `prf` input, and its output wraps
each key the daemon mints.

What that costs, and what it does not:

- **Support is degraded, never branched on a user agent.** An authenticator
  that ignores the extension answers an ordinary successful assertion with
  nothing attached: the person is verified, the session is bound, and only
  the cold start is missing. What a browser reports and what its
  authenticator does are different questions.
- **One output per daemon, not per workspace**, because one gesture yields
  one output and asking per workspace would be the second prompt this
  decision exists to avoid. The (daemon, workspace) pair rides as AES-GCM
  additional data instead, so a blob copied between two workspaces on one
  device opens nothing.
- **A remembered copy never outranks a daemon decision.** The unlock is
  offered only where the daemon has not spoken; a refused renewal or a
  membership refusal is the daemon reaching this device, which is exactly
  when decision 3's revocation takes effect.
- **A blob that cannot be opened is deleted rather than retried.** Ciphertext
  nothing on the device can read, and a `bounded` lease already spent, both
  drop the stored blob — keeping either would keep offering an unlock that
  cannot succeed.

## Consequences

### What this makes possible

- Revocation is cryptographic rather than advisory, without E2EE.
- Reconnecting after a long offline stretch re-keys instead of re-downloading,
  which is what makes `bounded` usable rather than a penalty.
- An organisation with a compliance requirement can choose `no-offline` for an
  absolute guarantee, or `bounded` for one that holds against everything but a
  client that persists a key it was told not to.

### What is deferred, and what triggers it

- **How a policy is stated and distributed** — an increment. Today the tier
  is one process environment variable on one daemon; ADR-0042's
  "organisation-wide default" has nothing above a daemon to inherit from
  yet.

Decision 6's cold start is no longer on this list: it shipped 2026-09-21,
with ADR-0039 decision 6's gate, as one gesture.

### What gets harder

- Every read of a replica now passes through a decrypt, and the key's lifetime
  becomes a thing the app must manage correctly. The failure mode is quiet: a
  key persisted "for convenience" leaves every test green and the guarantee
  gone. This wants an executable guard, not a prose rule.
- A `no-offline` client must degrade legibly — "this workspace needs a
  connection" is a different sentence from "cannot reach the keeper".
- Decision 4 asks for a message the editor does not have yet.

## Alternatives considered

**A lease over a plaintext cache.** The first framing. Rejected: an expired
lease is the app declining to render bytes still on the disk.

**Cache-or-no-cache only, with the bounded tier waiting on E2EE.** The second
framing. Rejected on the owner's correction — expiring the key is not E2EE and
does not need it, and deleting the data is a worse way to end access than
withholding the means to read it.

**A one-time export key for a revoked person's un-merged edits.** Rejected by
the owner in favour of discarding them. The edits are the organisation's
content, and the export would reopen what the revocation closed.

**Accepting a revoked actor's offline edits up to the revocation time.**
Rejected: Loro operations carry no keeper-trusted clock, so "up to" cannot be
established and would be a guess presented as a rule.

## Addendum (2026-09-21): the write path for decision 1's tier, and its bar

Decision 1 named the per-workspace `replicaTier` override; nothing wrote it
until now — `PUT /api/workspaces/:workspaceId/replica-tier` does, with
`{ tier: null }` as the explicit clear back to the process default.

The bar is `runtime:admin`, not the `workspace:write` the rest of a
workspace's fields sit behind. A tier is a security-posture change about
whether a copy of a workspace may leave the daemon at all — an operator's
call, not something any member of a workspace may relax for everyone.
`route-scope-registry.ts`'s `workspace replica-tier` rule places it beside
membership and grant management, ahead of the broader `workspaces (rest)`
fallback so a caller scoped only to `workspace:write` cannot reach it.

Said plainly, matching the same caveat membership and grant management
already carry (`routes/membership.ts`'s header): under the accepted v1
posture a pairing grant carries every scope, so a paired browser session
clears this bar today too, not only the daemon token or an operator-issued
macaroon/OAuth grant. Narrowing what a pairing session may do is a future
increment shared with those two surfaces, not something this route does on
its own.

## Addendum (2026-09-21): key rotation, and the reading it settles

`workspace-replica-key-store.ts`'s header used to say the read-plane
workspace key is "minted lazily on first read and never rotated by this
store — a rotation is a (not yet built) explicit route, not a side effect of
a read." This addendum builds that route and records the design question it
had to answer first, because the two readings differ in whether the
per-document `epoch` (`read-plane.ts`'s `deriveDocumentKey`) plays any part
in rotation at all, and picking the wrong one would have made the other
false.

**Reading A — replace the workspace key.** A new random key + salt.
Every document key derived from the old pair differs, so every ciphertext
already sealed under it stops opening the moment rotation lands.

**Reading B — bump an epoch.** The workspace key stays; a document is
re-keyed at a higher epoch only as it is re-sealed, so old-epoch ciphertext
stays readable until then.

**This is Reading A**, and the epoch plays no part in it. The reason is
what rotation is FOR: a workspace key is rotated when it is suspected
compromised, and the whole point is to deny the holder of the OLD pair —
under Reading B, that holder still derives every old-epoch document key from
the pair they already have, so B denies them nothing and is not a response
to compromise at all. `POST /api/workspaces/:workspaceId/replica-key/rotate`
therefore calls `WorkspaceReplicaKeyStore.rotateKey`, which overwrites the
row's `key` and `salt` outright in one upsert statement (atomic with respect
to a concurrent `keyFor`, so a reader never derives a key from a torn mix of
the old and new pair). `deriveDocumentKey`'s `epoch` parameter is untouched
by rotation and stays exactly what it was before this addendum: a
per-DOCUMENT number with no per-workspace meaning to bump.

**What this denies, and what it does not — the same honesty ADR-0043
decision 2 holds for the act plane applies here.** Rotation is not
"cryptographically revoked" for anyone already holding the old pair:

- A session that already has the old key **in memory** keeps reading with
  it, and keeps SEALING NEW WRITES under it, until it next asks the daemon
  for a key and receives the rotated one. Rotation does not reach into a
  live tab.
- Whoever held the old pair keeps every byte they already copied — the old
  ciphertext AND the old key that opens it. Rotation denies future reads
  under the new pair; it does not undo past exposure.
- **Every browser replica sealed under the old pair becomes unreadable and
  must be re-pulled.** This is a real cost, not a footnote: a workspace with
  a large offline replica pays a full re-download after a rotation, over
  whatever link the browser has at the time.

**The response carries a `keyId`** (`sha256("wb-workspace-key-id-v1" ‖ key ‖
salt)`, truncated and base64url-encoded — never stored, so it cannot drift
from the bytes it names), both from the rotate route and now optionally from
the plain key route. This is the contract the browser-side half of this
feature — recording the `keyId` a cached replica was sealed under, dropping
and re-pulling on a mismatch, and a page state for "the copy on this device
can no longer be opened" distinct from `locked` (which promises the copy
comes back once the daemon is reachable — after a rotation, reaching the
daemon is not what brings it back) — is handed to as a filed follow-up. That
lane owns `replica-session-key.ts`, `replica-store.ts`,
`replica-page-state.ts` and `replica-state-copy.ts`; this addendum ships the
`keyId` those files need to tell rotation apart from corruption, since
without it a post-rotation AEAD failure reads as `StoredDocumentUnreadableError('malformed')`
— "this document is damaged" — which is exactly the surprise a rotated key
must not produce.

**The epoch item goes back on the backlog with "no purpose found."** Nothing
in this system bumps a document's epoch today, and rotation — the feature
the epoch's own module comment named as its reason for existing — turns out
not to use it either. Filed as a whiteboard issue rather than closed, so the
next reader does not have to re-derive this.

The bar is `runtime:admin`, the same as decision 1's tier route above and
for the same reason: rotation is a security-posture change at least as
consequential as a tier change, and `route-scope-registry.ts`'s `workspace
replica-key rotate` rule places it ahead of the broader fallback. It is
deliberately NOT gated on tier — a `no-offline` workspace must still be
rotatable, or a workspace with a suspected-compromised key and no offline
copies becomes the one workspace nobody can fix. The same honest limit as
decision 1's tier addendum applies unchanged: under the accepted v1 posture
a pairing grant carries every scope, so this bar does not today separate an
operator from a paired browser session.
