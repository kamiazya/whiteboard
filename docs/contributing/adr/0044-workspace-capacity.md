# ADR-0044: A workspace's capacity is an infrastructure limit, refused at the edge and promoted before it

**Status:** Proposed — the shape is decided and one number is deliberately
not. Decisions 1, 2 and 4 are ready to build; decision 3's threshold is left
as a measurement rather than a value, because a fraction chosen by feel
becomes a constant nobody can move afterwards. Nothing here commits to a
Cloudflare Worker keeper: that is the forcing case, and
[ADR-0020](0020-coordination-boundary.md)'s "the self-hosted story stays one
container" stands until something reverses it deliberately. Depends on
[ADR-0023](0023-replica-model.md) for what "migrate" means and on
[ADR-0035](0035-device-keys-and-keeper.md) decision 4 for why moving a
workspace between keepers costs governance rather than identity.

## Context

**Nothing in this codebase refuses a write because a document or a workspace
record grew too large.** Measured 2026-09-22 across `packages`, `apps` and
`docs`: no quota, no maximum document size, no maximum snapshot size, no
row-count ceiling on stored data, and no warning either.

Three things look like limits and are not.

- `chunkSnapshot`'s `maxChunkBytes` is a splitting parameter. It decides how
  a snapshot is cut into rows, never whether it may be stored. As of
  2026-09-22 it has one declaration, `DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES` in
  the `ports` package, and a scan that fails on a second — which matters
  here only because a backend declaring its own capacity will also want its
  own chunk size, and there is now one place saying what the existing planes
  use.
- `COMPACT_DELTA_BYTES` (64 KiB) triggers a FOLD. It keeps the delta log
  short; it refuses nothing.
- The HTTP body limits — 16 MiB on a workspace-document update, 24 MiB on a
  promote, 4 MiB on JSON-RPC — bound ONE request. A workspace can grow past
  any of them freely through many small updates, and the update route then
  refuses only an oversized single POST.

**The only written statement of a capacity policy in the whole repository is
a comment for a feature that no longer exists** — in the daemon's document
store, above the workspace-document cache:

> Soft cap for snapshot size. Do not block saves when exceeded because
> preserving user data is more important; emit one warning per threshold
> breach and suggest compactDocument().

The constant and the warning code are gone; the sentence remains. It is the
right policy for a limit the product chooses, and the wrong policy for a
limit the infrastructure imposes. Telling those apart is what this ADR is
for, because until now there has been no limit of either kind and so no
reason to.

The forcing case is a keeper on a runtime with a hard ceiling. A Cloudflare
Durable Object holds 128 MB per isolate, WebAssembly allocations included,
and a Durable Object is the shape a Worker-hosted keeper takes: the write
path assumes one live `LoroDoc` per workspace in one process
(`workspaceDocCache`, in the daemon's document store), which is
per-workspace instance affinity and nothing else. **A ceiling like that cannot be honoured
by warning.** Past it the write does not degrade, it fails, and the process
holding the document may not survive to report why.

## Decision

### 1. A capacity limit is declared by the BACKEND, never chosen by the product

The number is a property of where a workspace is kept, so each keeper
declares its own and a workspace inherits the one belonging to its keeper.
The browser's IndexedDB, the daemon's libSQL over a filesystem, and a
Durable Object have three different ceilings and no useful common value.

Consequently the limit is not a setting. An operator cannot raise it, for
the same reason they cannot raise a disk.

### 2. At the limit, the write is REFUSED

This reverses the removed feature's "warn, never block", and the reversal is
the point rather than a change of taste. That policy was correct for a
product-chosen soft cap, where exceeding it costs tidiness and blocking it
costs a person their work. It does not survive an infrastructure ceiling,
where continuing costs the write anyway and possibly the process with it. A
refusal that names the reason is strictly better than a failure that does
not.

A refusal must say which limit was reached and what the person can do, and
must leave the record readable. Refusing a write is not permitted to make
the existing content unreadable.

### 3. Below the limit there is a PROMOTION BAND, and its threshold is derived rather than chosen

At a stated fraction of capacity the keeper offers migration, so the limit
is reached with warning rather than discovered at it. The band exists to buy
grace: a person whose workspace is approaching its keeper's ceiling should be
moving it before writes start failing, not after.

**The fraction is left open on purpose.** It is the point at which a
migration can still complete comfortably, which follows from how long a
migration of a record that size takes and how fast the record is growing,
and neither has been measured. Per the `measured-change` discipline the
instrument lands before the number.

What IS decided: the band exists, crossing it is a state a keeper REPORTS
rather than a log line, and the number is one measurement away rather than
one opinion away.

### 4. A backend may not declare a limit it can reach until a migration target and a path exist

A hard limit with nowhere to go is a dead end wearing a warning label. A
keeper whose ceiling is reachable in practice ships with somewhere for a
workspace to move to, and with the move implemented.

The path already has a shape, and the part to copy is the verification
rather than the direction. ADR-0023's promote moves a whole workspace record
between keepers as a CRDT merge, preserving identity and history; the old
copy is deleted only after every document and image has been read back from
THIS device's own replica, never from the response that was just imported,
which proves only that the network worked. What does not exist yet is the
reverse direction, out of a daemon, and the nine daemon-side tables with no
port are exactly what has no answer.

## Consequences

### What becomes easier

- A keeper with a hard ceiling becomes deployable at all. Without this, such
  a keeper's only options were to break silently past its limit or to not
  exist.
- The limit becomes a fact a person can plan around rather than a cliff.
- Because the number belongs to the backend, adding a keeper does not
  re-open the policy.

### What becomes harder

- Every write path gains a refusal case, and each one needs a sentence a
  person can act on. The single-definition discipline the web app keeps for
  destructive confirmation copy applies here too.
- Capacity has to be measurable cheaply, on the write path, without reading
  the whole record. What that measurement is, per backend, is not decided
  here.
- The promotion band is a new user-facing state, and one that appears only
  when a workspace is large is easy to ship broken. It needs a test that can
  put a workspace over the band without growing one.

### What this ADR does NOT decide

- **Whether a Cloudflare Worker keeper is adopted.** The forcing case, not a
  commitment.
- **Whether 128 MB is enough for a realistic workspace.** Unmeasured, and it
  is the measurement that decides whether such a keeper is worth building.
- **The band's fraction**, per decision 3.
- **Per-document limits.** This is about a workspace record, the unit a
  keeper holds and the unit that would exceed an isolate.

## Alternatives considered

**Keep "warn, never block".** Rejected for an infrastructure limit, and kept
for anything the product chooses. The removed soft cap's reasoning is sound
where blocking is a choice; at a hard ceiling it is not a choice, and warning
only removes the chance to say why the failure happened.

**Make capacity an operator setting.** Rejected. It invites an operator to
raise a number their infrastructure does not honour, and the first symptom
would be a dead isolate rather than a refused write.

**Refuse at the limit with no promotion band.** Rejected as the whole of the
design: correct, and too late. A person discovers the ceiling at the moment
they can no longer write, which is the moment migrating is hardest.

**Split a workspace automatically as it approaches the limit.** Rejected for
now. It changes what a workspace IS to solve a storage problem, and
ADR-0009's vocabulary makes the workspace the unit a person names and
shares. A person choosing to split is a different feature from a keeper
doing it silently.

**Migrate automatically at the band instead of offering.** Rejected. A
migration changes which keeper holds the data, which ADR-0035 decision 4
makes a governance change, and a governance change is not something a
threshold performs on someone's behalf.
