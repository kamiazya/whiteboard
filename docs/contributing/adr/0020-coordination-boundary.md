# ADR-0020: The coordination boundary — a CRDT data plane and a compare-and-swap control plane

**Status:** Proposed

## Context

Running more than one server process against one workspace is not possible
today, and the ambition is a self-hosted deployment that scales out and,
later, a multi-tenant SaaS. The question that motivated this record was
which consensus protocol to adopt — Raft, Paxos, or ZAB. The answer is
none of them, and the reason is worth recording because it is not obvious
and the opposite choice is expensive to undo.

### The edit path is already multi-writer safe

`DocumentStoreWorkspaceDocs.save()`
(`packages/workspace-index/src/document-store-workspace-docs.ts`) exports
the ops the stored state lacks and appends them:

```ts
const update = doc.export({ mode: 'update', from: VersionVector.decode(stored.frontier) })
await this.store.appendDeltas({ docRef, deltaBatch: { updates: [update], newFrontier } })
```

`LibsqlDocumentStore.appendDeltas` allocates `max(seq) + 1` inside a single
transaction. Loro ops carry their own identity, so an update exported from a
stale in-memory doc is still valid against a log that already holds another
writer's ops. Two processes appending concurrently converge. A stale
document cache is therefore a *visibility* problem, not a correctness one —
which is the opposite of what a first reading suggests, and is why this
paragraph exists.

### Four places where convergence stops covering, measured

1. **Compaction is a read-modify-write that does not append.** In `save()`'s
   `shouldCompact` branch the new ops are folded into a fresh snapshot and
   `saveCompactedSnapshot` replaces the snapshot row wholesale
   (`onConflict().doUpdateSet()`) while deleting the oldest
   `supersededDeltaCount` deltas. The implementation reasons correctly about
   a concurrent *append* — the comment says "everything appended after the
   caller folded is not in the snapshot" — and not at all about a concurrent
   *compaction*. Two processes compacting the same document each write a
   snapshot holding only their own new ops; the second write wins and the
   loser's ops exist nowhere, because the compaction branch never appended
   them as a delta. This is permanent data loss, not staleness.

2. **A fold computed from the writer's own doc, rather than from the record.**
   The compaction branch exported its snapshot from the `LoroDoc` the caller
   handed it. That doc is one writer's VIEW — whatever that instance held when
   it last read, plus its own edits — so folding it replaces the record with a
   subset of itself, dropping every op this instance never saw. The generation
   fence does not catch this and cannot: nobody REPLACED the snapshot, so the
   compare-and-swap legitimately succeeds. The superseded count makes it
   worse, dropping a delta prefix the new snapshot does not contain.

   This was found by the multi-instance convergence property, after the fence
   was already written and every example test passed. It is the reason the
   property exists and the reason a fence alone is not the answer: **a fold
   must be computed from the stored snapshot plus the stored log, never from a
   writer's doc.** `loro-store.ts` in the browser already folded that way; the
   daemon-side path did not, and no test compared them.

3. **The stored frontier is a last-write-wins scalar.** `newFrontier` on the
   append path is the writing process's own `doc.oplogVersion()`, so a second
   writer's frontier overwrites the first's rather than joining with it. What
   this produces is an UNDER-claim — the record reports a version older than
   the log it holds — so today it costs a redundant export rather than an op,
   and every current reader is safe. It is nonetheless wrong, and it is
   currently invisible because `loadDeltas` ignores `sinceFrontier` and
   returns the whole log, a behaviour the port's own conformance suite pins
   (`packages/ports/src/test-utils/document-store-conformance.ts`, "ignores
   sinceFrontier and returns the whole log"). Anything that later reports sync
   status, or decides what to send a peer, reads this value and would be told
   the record is behind when it is not. The fold path now writes the merged
   version vector; the append path is the increment still outstanding.

4. **State outside the CRDT.** Blobs and versions are files
   (`FileVersionStore` writes `<dataDir>/blobs/<workspaceId>/versions/*.png`),
   and `file-gc` computes a referenced set and then unlinks. Neither is a
   CRDT operation, and unlinking is not monotonic: one process's GC can
   delete a blob another process's concurrent edit has just referenced. This
   is the *only* thing `withWorkspaceWriteLock` protects, and its own comment
   says so — "The lock is in-process only ... If the daemon is ever forked
   this needs to become a file lock."

### Convergence is not invariant preservation

`saveDocument` refuses a path already held by a different document, a
check-then-act against the workspace tree. Two processes creating the same
path concurrently both pass the check, both write, and the CRDT converges to
a state holding two documents at one path. Converged, and invalid. Path
uniqueness is not a property a CRDT can supply.

### The constraint that decides the whole question

`apps/web/src/lib/idb-document-store.ts` implements the same `DocumentStore`
port, and `browser-workspace-docs.ts` runs the *same* `save()` against
IndexedDB. The class comment names this directly: "over any `DocumentStore`
— which is to say, over both keepers."

The edit path therefore has a participant that is offline by design and can
never reach a quorum. A browser keeper storing a workspace with no network is
a product promise (`docs/how-to/connect-to-local-daemon.md`), not an edge
case. Any coordination step placed in the edit path makes that mode
unimplementable.

## Decision

**1. The data plane is coordination-free, permanently.** Document edits and
presence converge through Loro and never acquire a lock, a lease, or a
quorum. This is a standing constraint on future work, not a description of
the current implementation: a proposal that adds a coordination step to the
write path is rejected on that basis alone, because it breaks the browser
keeper.

**2. The control plane is linearizable, and rented rather than built.**
Compaction rights, GC rights, tenant records, and quota counters need
linearizability. That is obtained from the database already in the
dependency graph — a libSQL/SQLite transaction today, Postgres if write
throughput demands it later. **No consensus protocol is implemented in this
repository.**

**3. Correctness comes from compare-and-swap with a fencing token; leader
election is only an optimisation.** Every destructive or
read-modify-write control-plane operation carries a monotonic generation and
is rejected by storage if the generation is stale. Concretely,
`documentSnapshots` gains a `generation` column and `saveCompactedSnapshot`
becomes conditional; a loser re-appends its update as a delta instead of
compacting.

The fence is necessary and **not sufficient**, which is worth stating because
the first implementation of this decision stopped there and was still wrong.
It arbitrates writers RACING for the same row; it says nothing about a writer
whose own view is narrower than the row it is about to replace. So it comes
with a second rule of the same standing: **an operation that rewrites shared
state derives its new value from the stored state, never from the caller's
copy of it.** Both are required, and only the property test checks the pair —
each one alone passes every example written for the other.

This ordering is the substance of the decision. A lease can expire while its
holder is stalled, so a lease alone does not make a destructive operation
safe; a guard in storage does. Once the guard exists, **a leader is not
required for correctness**, which is what lets this repository reach
multi-instance operation with no coordination infrastructure at all. Leader
election may be added later to stop several processes doing the same
discardable work, and when it is, it is rented too (a `leases` table, a
Postgres advisory lock, or a Kubernetes `Lease` — never a bespoke
implementation).

**4. Invariants a CRDT cannot preserve are resolved by deterministic
convergence, not by a uniqueness authority.** Path uniqueness is settled
after the fact: both creations survive the merge and a deterministic rule
keyed on Loro's own op identity picks the holder of the path, renaming the
loser. Routing creation through an authority would violate decision 1.

## Consequences

Easier:

- Multi-instance operation needs no new infrastructure. The first increment
  is a schema migration and a conditional `UPDATE`.
- The self-hosted story stays one container. "Also run a three-node etcd
  cluster" would have cost more than the feature is worth to most operators.
- The browser keeper, offline editing, and the daemon keeper keep sharing one
  write path. A coordination-free data plane is what makes one `save()`
  serve all three.
- A later SaaS control plane is an ordinary relational schema — tenants,
  quotas, billing — with no replicated state machine to operate.

- The claim itself is checkable. `multi-instance-convergence.test.ts`
  generates command sequences over N instances sharing one store, each
  holding its own doc, and asserts that no acknowledged write is lost and
  that every instance agrees on re-read. It runs against the in-memory store
  and the real libSQL one, and it asserts in `afterAll` that the sequences
  actually reached a fold and a refused fold — a generator that drifts away
  from the interesting arrangements fails rather than passing vacuously.

Harder, or deliberately given up:

- No global ordering of document operations. Anything wanting "the Nth edit"
  or a linearizable history has to be derived, not read.
- Every destructive control-plane operation must be written in
  compare-and-swap form. That is a discipline reviewers have to hold, and
  the failure mode of forgetting is silent.
- Uniqueness is eventual. A user can briefly observe two documents at one
  path before the resolver runs, and the resolver renames something the user
  named. The UI has to make that legible rather than hide it.
- Read-your-writes across instances is not free. A client that writes to one
  instance and reads from another can see the older state until the update
  propagates; sticky sessions or a frontier-aware read are the mitigations.

## Alternatives considered

**Raft, implemented in this repository.** Rejected. It supplies a replicated
log, and a replicated log already exists — the CRDT delta log. Owning
membership changes, log compaction, and snapshot transfer is a large,
permanent correctness liability bought for coordination that decisions 3 and
4 remove the need for.

**Raft, rented (etcd, Consul, Kubernetes `Lease`).** Not rejected —
deferred. This is the right answer *if* leader election is ever wanted for
efficiency, and on Kubernetes the `Lease` object costs nothing extra because
the operator already runs etcd. It is not adopted now because nothing needs
it: the generation guard is what makes compaction safe.

**ZAB / ZooKeeper.** Rejected on operational cost. A JVM ensemble alongside a
product whose distribution promise is one container, or `npx`, is a poor
trade for a lease this design does not require.

**Paxos.** Rejected. No canonical implementation to adopt, and Multi-Paxos
offers nothing over Raft except worse documentation.

**Raft-replicated SQLite (rqlite, dqlite).** Kept in reserve for one specific
scenario: an operator wanting high availability with no external database. It
is the cheapest path to consensus *if that requirement appears*, because the
storage layer is Kysely over a SQLite dialect and the schema would survive a
dialect swap. Not adopted speculatively.

**A distributed lock service (Redis, Redlock).** Rejected. It adds
infrastructure to obtain a lease that is still not sufficient without a
fencing token — and once the fencing token exists in storage, the lock is
redundant.

**Single-writer sharding: route every workspace to one owning process.** This
is how much collaborative-editing infrastructure is built and it genuinely
solves the three unsafe spots, so it deserves the honest comparison. It is
not adopted because it requires a routing tier that knows the current owner
of every workspace (itself a consensus problem, usually delegated to the same
etcd), it fails closed when the owner is unreachable, and it has no answer
for the browser keeper, which owns its workspace and is not reachable by any
router. The CRDT plus compare-and-swap design degrades instead: a partitioned
process keeps accepting edits and converges when it returns.
