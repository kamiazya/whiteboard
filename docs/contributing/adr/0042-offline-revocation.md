# ADR-0042: An offline policy decides whether a replica exists, not how long it lives

**Status:** Accepted — human gate 2026-09-19. Design of record; nothing
implemented. Split out of [ADR-0041](0041-profile-and-authority.md), which
decides profiles and authority and defers this. Constrains
[ADR-0023](0023-replica-model.md) decision 2's offline-readable replica with an
organisation policy, and leaves a hard guarantee over already-cached bytes to
[ADR-0035](0035-device-keys-and-keeper.md)'s deferred E2EE case.

## Context

ADR-0041 decision 3 gives a keeper L1 (access to a resource) and L2
(acceptance of a credential). Both are a state change at the keeper, and
neither reaches a holder that is not listening.

ADR-0023 decision 2 makes a replica readable while the keeper is unreachable.
That is a feature and it is the obstacle: an enterprise asking for immediate
revocation is asking for it to stop being true.

### A lease over a plaintext cache is an advisory, not a guarantee

The first framing of this ADR offered "a lease with a TTL" as the way to bound
exposure. Measured against what this project already documents about its own
storage, that option is weaker than it sounds.

`docs/explanation/security-model.md` states that a browser keeper's canvases,
files and CRDT history in IndexedDB "remain readable by whatever later owns the
origin", and that there is "no equivalent fix available" — the data has to be
addressable by the origin for the runtime to work. So when a lease lapses, what
happens is that **the application declines to render bytes that are still on
the disk**. An honest client honours it. Anything with origin access does not
have to.

That reframes the whole question. The three options are not equally strong:

| | guarantee over bytes already cached |
|---|---|
| no cache exists | **real** — there is nothing to read |
| lease expires | advisory — depends on the client |
| cache forever | none, by design |

The only mechanism that would make an expiring lease a real guarantee is
content encrypted under a key the client must fetch. That is ADR-0035's
deferred E2EE case, whose candidate (`prf`-derived wrapping) that ADR records
as unevenly supported and carrying its own recovery dependency. It is not
available to build on today.

### The admin can evaluate one of these questions and not the other

ADR-0023 decision 1 rejected a global cache-strategy setting because "a mode
toggle would name a mechanism users cannot evaluate; the keeper names the thing
they actually decide about". The same test applies here and separates the
options cleanly:

- *"Do our people need to work offline?"* — an administrator can answer this.
- *"What is the correct TTL in hours?"* — an administrator cannot, because that
  number is the maximum exposure window and the maximum offline working time
  read from two sides, and nothing tells them where to put it.

### Reading and editing offline are two different risks

Named by the owner, and absent from the first framing:

- **reading** offline is an exposure risk — content is on a machine the
  organisation no longer controls;
- **editing** offline is a different one — a person revoked while disconnected
  reconnects carrying edits, and the keeper must decide what to do with them.

A CRDT makes the second harder than it looks. Loro operations carry no wall
clock the keeper trusts, so "accept everything authored before the revocation"
is not a query the merge can answer.

## Decision

### 1. The policy chooses whether a replica exists, not how long it may live

An organisation states, per workspace and defaulting from an organisation-wide
setting, whether its workspaces may be replicated to a client at all. That is
the axis, because it is the one with a real guarantee at one end and a question
an administrator can answer.

This is the shape Google Workspace uses for offline access, which the owner
raised as prior art: an administrator turns offline access on or off for a
group, rather than tuning how stale an offline copy may be.

### 2. Three tiers, and the middle one is honest about what it buys

| tier | replica of an organisation workspace | revocation takes effect | cost |
|---|---|---|---|
| **no-offline** | not created; reads require the keeper | immediately, by construction | no offline work at all |
| **offline** (default) | created, no expiry | at the next reconnect | bytes cached before revocation stay readable |
| **bounded** | created, lease with a TTL | at the next reconnect, or at lapse | an *advisory* bound; see Context |

`no-offline` and `offline` are the decision. **`bounded` is specified but not
built**: until content is encrypted under a fetched key it adds a rarely
exercised code path in exchange for a guarantee the storage model does not
support, and shipping it would invite exactly the misreading this ADR exists to
prevent. Its trigger is E2EE landing.

### 3. Reconnect is where a revocation is applied, and the purge is best-effort

On reconnecting, a client learns its access was revoked and removes the local
replica. `demote-browser-workspace.ts` already deletes a browser workspace
record after a verified move, and the registry row with it, so this is that
machinery pointed the other way rather than a new one.

**It is best-effort, and must be described that way anywhere it is surfaced.**
A revoked client is by definition one the organisation no longer controls; a
purge it is asked to perform is a request. The guarantee that does hold is
narrower and worth stating on its own: **after revocation, no further content
reaches that client.** Anything already on the disk was already exfiltratable
before the revocation was issued, which is what tier `no-offline` exists to
prevent in the first place.

### 4. Edits made offline by a revoked actor are refused, and kept for their author

They are not merged. The keeper rejects the push, because the alternative is a
person the organisation has removed writing into its document, and the CRDT
cannot offer the middle option — Loro operations carry no keeper-trusted
timestamp, so "accept what predates the revocation" is unanswerable.

The refusal does not destroy the work. The client keeps the un-merged edits
locally and offers them as an export, so the outcome is "your changes could not
be sent, here they are" rather than silent loss. A person whose last day was
spent working on a plane should not discover the work is simply gone.

## Consequences

### What this makes possible

- An organisation with a compliance requirement can have a real guarantee by
  choosing `no-offline`, and pays for it in offline capability rather than in a
  number nobody can justify.
- Everyone else keeps ADR-0023's behaviour unchanged, which stays the default.
- "Immediate revocation" becomes a claim this project can make precisely, and
  only for `no-offline`.

### What is deferred, and what triggers it

- **`bounded` as a real guarantee** — trigger: E2EE (ADR-0035), which makes an
  expired lease mean the bytes cannot be read rather than will not be shown.
- **How a policy is stated and distributed** — an increment. The decision here
  is the axis and the tiers.

### What gets harder

- Two storage behaviours for organisation workspaces, and a `no-offline` client
  must degrade legibly: "this workspace needs a connection" is a different
  sentence from "cannot reach the keeper", and they must not look the same.
- Decision 4 asks for an export path that does not exist yet, and a rejected
  push is a state the editor has to render.

## Alternatives considered

**A lease with a TTL as the primary answer.** The first framing. Demoted to a
specified-but-unbuilt tier once the plaintext-cache fact was checked rather
than assumed: it reads as the rigorous option and is the one whose guarantee
the storage model cannot back.

**Deciding nothing until a deployment with the requirement exists.** This
ADR's own previous revision. Superseded by the observation that the policy
axis — cache or no cache — does not need that evidence, because it is not a
calibration. Only the TTL needed a number, and the TTL is what is deferred.

**Accepting a revoked actor's offline edits up to the revocation time.** The
apparently fair option; rejected in decision 4 because the CRDT cannot
establish "up to" against a clock the keeper trusts, so it would be a guess
presented as a rule.

**Deleting the author's un-merged edits on refusal.** Rejected as the kind of
data loss a person cannot anticipate or recover from, for no security gain —
the edits are already on their disk either way.
