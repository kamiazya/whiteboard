# ADR-0042: An offline policy decides whether a replica exists, and revocation withholds its key

**Status:** Accepted — human gate 2026-09-19. Design of record; nothing
implemented. Split out of [ADR-0041](0041-profile-and-authority.md), which
decides profiles and authority. Constrains [ADR-0023](0023-replica-model.md)
decision 2's offline-readable replica with an organisation policy, and makes
the revocation cryptographic rather than advisory. The cold-start-offline case
is the one part deferred, and it shares a gesture with
[ADR-0039](0039-passkey-attestation.md) decision 6.

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

[ADR-0043](0043-authority-as-keys.md) decision 3 makes this key the root of an
`HKDF(workspaceKey, documentId)` derivation tree, so a holder can be given one
document rather than the workspace. The in-memory rule above applies unchanged
at every level of that tree.

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
disk at all; `offline` and `bounded` rest on the key never being persisted.

### 6. Cold-start offline is deferred, and its gesture already has an owner

A key held in memory is gone when the tab closes, so reopening offline finds
ciphertext and no key. Making that work means persisting the key **wrapped by
something not stored beside it** — WebAuthn's `prf` extension, which ADR-0035
names as a wrapping mechanism and which unwraps without a network.

Deferred rather than decided, but the reason to wait is thinner than ADR-0035
suggests: that ADR called `prf` support uneven, and ADR-0039's own measurement
of 2026-09-13 found it **broadly available on platform authenticators**
(Safari 18+ and macOS 15, Firefox 139+, Chrome 147 on Windows). The remaining
cost is the one ADR-0035 names and this ADR does not solve: the passkey
provider becomes the recovery path.

When it lands, it should be the **same gesture** as ADR-0039 decision 6's
user-verification gate: unlocking a workspace and obtaining its key are one
action, not two prompts for the same intent.

## Consequences

### What this makes possible

- Revocation is cryptographic rather than advisory, without E2EE.
- Reconnecting after a long offline stretch re-keys instead of re-downloading,
  which is what makes `bounded` usable rather than a penalty.
- An organisation with a compliance requirement can choose `no-offline` for an
  absolute guarantee, or `bounded` for one that holds against everything but a
  client that persists a key it was told not to.

### What is deferred, and what triggers it

- **Cold-start offline** — decision 6. Trigger: ADR-0039 decision 6's gate
  being built, since they are one gesture.
- **How a policy is stated and distributed** — an increment.

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
