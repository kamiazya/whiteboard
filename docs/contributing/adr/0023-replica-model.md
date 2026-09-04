# ADR-0023: A workspace has one keeper; every other copy is a replica

**Status:** Accepted — decisions 1–5 are implemented; the dated notes under each decision say what landed when. Remaining later work: offline replica EDITS (decision 3 shipped read-only v1)

## Context

The keeper axis names who KEEPS a workspace — the browser's own storage or
the whiteboard daemon (`.claude/rules/vocabulary.md`, "The keeper axis").
The intended model was stated when the axis was named: connecting a daemon
PROMOTES a workspace's source of truth to it, *with everything below
becoming a replica*. Half of that model shipped and half did not:

- **The move half is implemented.** Settings > Connections' "This
  workspace" section transfers the browser's whole workspace record into a
  daemon workspace as a CRDT merge — identity, history and referenced
  images survive. A moved-disclosure marker stops the browser copy silently
  resuming as its own keeper.
- **The demote half is not.** After the move, the browser record remains an
  independent store rather than a subscribed replica. Continuing from the
  daemon is a narrated reload the user takes; the bytes of the old copy
  stay where they were.

So duplication is not a risk, it is the current behaviour: every promoted
workspace exists twice, and the browser copy is a frozen fork that only a
disclosure banner distinguishes from live data.

Three user requests arrived together (2026-09-01) and are all, on
inspection, this missing half:

1. *"Choose a cache strategy — keep data in the browser, or assume the
   daemon and keep it there."* The choice of where data authoritatively
   lives is the keeper, and the keeper is already a per-workspace property
   with a move action. What cannot be chosen today is the other option:
   "assume the daemon" — because without demote the browser never stops
   being a second full copy.
2. *"A transparent mode: the PWA accesses a directory the OS owns, so data
   is not duplicated."* The goal (no duplicate authoritative copies) is
   right; the mechanism cannot work. The daemon's record is SQLite, and a
   second writer on the same files corrupts it — the same reason
   ADR-0020's scale-out work made the database location configurable
   instead of sharing the file. What "transparent" actually wants is a
   copy that is *not authoritative*: a replica.
3. *"Storage visibility in the browser too."* Shipped separately (the setup
   journey's per-step evidence); it matters here because replica semantics
   are only trustworthy when the user can see what is where.

### What the data plane already guarantees

[ADR-0020](0020-coordination-boundary.md) established that the edit path is
multi-writer safe: Loro ops carry their own identity, deltas append rather
than overwrite, and two writers appending concurrently converge. A browser
holding a stale copy of a daemon workspace is therefore a *visibility*
problem, not a correctness one. That is the load-bearing fact of this ADR:
a replica that keeps taking edits offline and appends them later is safe
**on the data plane** without any new machinery.

The same ADR lists where convergence stops covering: compaction,
control-plane rows (names, placement, versions, branches), anything
read-modify-write. A replica must not perform those against a keeper it
cannot reach.

## Decision

Five decisions, ordered so each builds on the previous.

### 1. The keeper is exclusive, and it is a property of each workspace

Exactly one keeper per workspace at a time. Every other holder of the
record is a replica: readable, overwritten by sync, never authoritative.
There is consequently **no global "cache strategy" setting** — the choice
surfaces per workspace as what it already is (this workspace is kept in
this browser / kept by the daemon) plus the move action. A mode toggle
would name a mechanism users cannot evaluate; the keeper names the thing
they actually decide about.

### 2. Demote completes promote

Promote's missing second half: after a successful move, the browser record
becomes a **subscribed replica** of the daemon workspace instead of a
moved-marked independent store. Concretely:

- The replica serves reads: warm start, and offline availability when the
  daemon is unreachable.
- Sync overwrites it; it never wins an argument with the keeper.
- The moved-disclosure banner is replaced by replica state ("kept by the
  daemon · cached here"), because the honest description changed.

The reload after promote stays narrated (the user takes it); what changes
is what they come back to.

> **Implemented 2026-09-04.** The pull half landed first (#1181:
> `replica-cache.ts`, the `storage.replicas` registry, `replica-refresh.ts`)
> with one hole: the promote path cached bytes without writing the registry
> entry, so a fresh replica was invisible to offline lookup until some later
> visit refreshed it. The completion closed that (the registry write moved
> into the promote flow, shared with the refresh via `withReplicaEntry`) and
> went one honest step further than the paragraph above: after a VERIFIED
> move — every image transferred, and the replica read back from this
> browser's own store holding every promoted document
> (`replicaCarriesAll`) — the source browser record is **deleted**
> (`demote-browser-workspace.ts`), not left as a moved-marked fork. The
> registry row is deleted with it; if it was the last browser workspace, a
> fresh empty one is minted in the same transaction (the boot resolve
> throws on an empty registry) and the in-memory identity is re-pointed. A
> move that cannot be verified keeps the browser copy and reports why.
> Planes keyed by DOCUMENT id (images, versions) are deliberately not
> deleted: the move preserves document ids, so the replica's documents
> share them.

### 3. Replica edits are data-plane only

While the keeper is unreachable, a replica MAY keep taking document edits:
they are CRDT deltas appended locally and shipped as ordinary ops when the
keeper returns, which ADR-0020 shows is convergent. It MUST NOT perform
control-plane operations offline — create/rename/move/delete of documents
or workspaces, version saves, branch operations, compaction — because those
are the operations convergence does not cover. v1 may ship read-only
replicas first; the edit capability is an extension inside the same
boundary, not a different design.

> **Read-only v1 implemented 2026-09-02 (#1182):** `ReplicaReadPage`, served
> when the kept daemon is unreachable and a replica exists — `open()` never
> `create`, value-only renderers, control-plane actions absent.

### 4. Transparent mode is rejected as specified, and its goal is met here

No shared OS directory. A browser writing the daemon's SQLite files — via
the File System Access API, OPFS mounts, or anything else — is a two-writer
corruption and is rejected permanently, not deferred. OS-directory access
appears in the design in exactly one legitimate shape: the daemon writing a
**one-writer export mirror** (ADR-0021's append-only blob mirror is the
precedent), which a later increment can offer for users who want plain
files on disk. Deduplication — the actual goal behind "transparent mode" —
is achieved by decision 2: the browser copy stops being a second
authoritative store.

### 5. Daemon-kept workspaces gain a browser cache by the same mechanism

Once demote exists, the same replica machinery applies in the other
direction of arrival: a workspace that was born on the daemon can be
cached in the browser for warm start and offline reads. This is the
"assume the daemon" cache strategy of request 1, obtained as a consequence
rather than as a separate feature. It is explicitly later work; nothing in
decisions 1–4 depends on it.

> **Implemented 2026-09-02 (#1181), ahead of decision 2's completion:**
> `DaemonDocumentPage` schedules `scheduleReplicaRefresh` on every daemon
> workspace resolve — once per (daemon, workspace) per session, off the
> critical path.
>
> **Freshness, 2026-09-04:** the dedupe holds only while the registry entry
> is within `REPLICA_STALE_AFTER_MS` (15 min), so a long working session
> re-pulls on a later resolve instead of letting its replica age all day;
> a failed pull writes no entry and is retried on the next resolve; an
> in-flight pull is never doubled. Still no timer loop — the ceiling is
> resolves, and each re-fire costs the one snapshot pull a visit already
> pays. The popover's replica notice now states the age ("Last synced …"),
> because a reader deciding whether to trust the offline copy needs it in
> the same breath as the claim.

## Consequences

- Promote stops leaving a fork behind; "where is my data" has one answer
  per workspace plus a visible cache.
- Offline reading of daemon workspaces becomes possible without new
  storage concepts — the replica is IndexedDB, where browser workspaces
  already live.
- The control-plane boundary (decision 3) becomes UI copy: offline, a
  replica shows documents and takes edits but greys out rename/version/
  branch actions with the reason. That is more honest than queuing
  control-plane intents, and enormously simpler.
- Two copies still exist on disk (a cache is a copy). The change is that
  only one is authoritative and the other says so. True single-copy
  storage was the rejected transparent mode.
- The sync scheduling, retry, and staleness display are new work with real
  cost; nothing here prices them. Each implementation increment must bring
  its own measurements per the measured-change discipline.

## Alternatives considered

- **Shared data directory ("transparent mode" literally).** Rejected:
  SQLite two-writer corruption; also couples the browser to the daemon's
  storage layout, which ADR-0021 is actively decoupling even for the
  daemon's own backups.
- **A global storage-mode setting.** Rejected: the keeper is per-workspace
  state with a per-workspace move action already shipped; a global mode
  would sit beside it answering the same question differently.
- **Queued offline control-plane operations.** Rejected for v1: ADR-0020
  shows exactly why those operations need the keeper (CAS, not
  convergence); a queue reintroduces the conflict cases the CRDT plane
  exists to avoid, for operations rare enough to wait.
- **Deleting the browser copy after promote (no replica at all).** Simpler,
  and rejected: it trades the duplication complaint for a cold-start and
  offline regression, and the moved-marker UX it would need is what we
  have today — the state this ADR exists to finish.
