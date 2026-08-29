# ADR-0021: Durability is a property of each store, not an operation on a directory

**Status:** Accepted — decisions 2 and 3 implemented (a database we do not
host is reported out of scope rather than refused wholesale; the rows are
captured by a hot snapshot, so backup no longer requires stopping the
server), plus the first slice of decision 1's per-store record. Decisions
4, 5 and 6 are not: `backup-retention.ts` and its property hold decision
6's invariant but nothing wires them yet.

## Context

`whiteboard server backup` copies the data directory and `whiteboard server
restore` copies it back. Both refuse to run while a server is alive, and the
self-hosting guide accordingly tells the operator to `docker stop` first.

That shape was right when it was written: one daemon, one directory, and
everything in it. It has since stopped being true in two directions, and is
about to stop being true in a third.

### The directory is no longer the whole record

[ADR-0020](0020-coordination-boundary.md) made the database location
configurable, because more than one instance cannot share a SQLite file. An
operator who points `WHITEBOARD_DATABASE_URL` at a libSQL server still has a
data directory — blobs and version thumbnails live there — but the rows do
not.

Nothing re-asked the whole-directory assumption when that changed. Measured,
before the guard that now prevents it:

```
outcome: {"schemaVersion":1,"ok":true,"operation":"backup"}
backup contents: [ 'blobs' ]
```

A backup of blobs alone, reported as success. That is the worst available
failure mode, because the operator stops worrying about it. An S3-backed blob
store — the next thing we intend to build — produces the exact mirror image:
the rows are captured and the blobs are not, with the same `"ok":true`.

The narrow guard is already in place: both commands now refuse when the
database is not inside the directory they copy. This ADR is about why that
guard should not be the answer for long.

### Stopping the server was never a data requirement

The stop-the-container constraint reads like a safety policy about consistent
state. It is not. It is a property of `cp` over a live SQLite file, and the
database can be snapshotted hot. Measured, on a live connection that keeps
writing:

```
snapshot bytes: 8192  snapshot rows: [{"v":"before"}]  live rows: [{"v":"before"},{"v":"after"}]
```

`VACUUM INTO` produced a snapshot closed at its own point in time, and the
connection carried on. The snapshot correctly does not contain the write that
followed it.

This matters more than a convenience. **A backup that requires downtime is one
an operator takes rarely, or not at all**, and the interval between backups is
the data they lose. Every property we want from backup — that it is recent,
that it is regular, that nobody has to remember it — is downstream of removing
the stop.

### The three data classes want different things

The whole-directory operation treats everything the same. They are not the
same:

| | Shape | What durability means for it |
|---|---|---|
| **rows** (libSQL) | mutable, needs a consistent cut | a point-in-time snapshot |
| **blobs** | content-addressed, immutable, append-only | a continuous mirror; no consistency problem exists |
| **version history** | rows plus blobs | nothing of its own |

Blobs are the interesting case. They are addressed by the sha-256 of their
own content, so two writers producing the same blob produce identical bytes at
an identical path. Copying one is idempotent, ordering-insensitive, and safe
to do concurrently with anything. Treating blobs as though they needed a
consistent cut is what forced them into the same stop-the-world operation as
the rows, and they never needed it.

## Decision

### 1. Durability is a property each store answers for, not an operation over a directory

The unit stops being "the data directory" and becomes the set of stores. Each
store answers two questions about itself: where its durable copy is, and how
far along it is. A backup is complete when every store says it is.

The direct consequence is that a store whose durability the product does not
provide — see decision 2 — is *visible* rather than silently absent. The
defect above was not a missing feature; it was a missing question. Nothing in
the system was in a position to notice that the rows were somewhere else,
because nothing was asking per store.

### 2. A database we do not host is not ours to back up, and we say so

When `WHITEBOARD_DATABASE_URL` points at a libSQL server, that server's
operator has point-in-time recovery, replicas, and a retention policy already
— Turso's or their own sqld's. Reimplementing it would be worse than what it
duplicates and would have to be maintained against every provider.

So the product does not try. It reports the database as out of its scope and
names what the operator is responsible for. **This is a real answer, not a
gap**: the failure this ADR exists to prevent is a backup an operator trusts
and cannot restore from, and an honest "not mine" prevents it completely,
while a half-implementation would not.

The embedded default is ours, and gets a hot snapshot per decision 3.

### 3. The rows are captured by a hot snapshot, taken through the database

`VACUUM INTO`, not a file copy — measured above to work on a live writing
connection. The server keeps serving. This is what makes decision 4 possible,
and it is the whole reason the stop-the-server constraint can go.

**It rests on WAL, which this ADR originally did not say.** The measurement
above was taken on the writing connection itself, where the locks are already
held and nothing contends. `whiteboard server backup` is a SEPARATE process
opening its own connection to the same file, and under SQLite's default
rollback journal that connection cannot read a database being written at all.
Measured cross-process, three snapshot attempts during a tight writing loop:

```
journal_mode=delete -> SQLITE_BUSY: database is locked        (3 of 3)
journal_mode=wal    -> ok in 9/17/22 ms, integrity ok         (3 of 3)
```

The same difference shows in the direction that matters for a daemon, and
there it is deterministic rather than timing-dependent: with a read
transaction held open — which is what a snapshot in progress is — a commit on
another connection raises `SQLITE_BUSY` under `delete` and succeeds under
`wal`. Under the default, *taking a backup stops the product working*.

So `db/index.ts` opens every database `PRAGMA journal_mode = WAL`. The cost is
one this deployment has already accepted: WAL needs real filesystem shared
memory and does not work over a network filesystem — and neither does the
locking this store depends on regardless, which is why
[ADR-0020](0020-coordination-boundary.md) sends multi-instance deployments to
a libSQL server rather than a shared file.

WAL cuts the other way for anything that copies FILES, and the cut is this
ADR's own failure mode. The newest commits live in `whiteboard.db-wal` until a
checkpoint folds them back, so a copy of the main file alone is short —
measured at **4977 of 5000 rows**, silently. The three files are one artifact
and travel together, which the whole-directory copy already does and the
`excludeDatabaseFile` filter had to learn. `VACUUM INTO` is immune by
construction: it writes a single self-contained database, which is one more
reason the snapshot replaces the file copy rather than sitting beside it.

**Implemented** as `snapshotDatabaseInto`, which `whiteboard server backup`
now uses for the rows whenever the database is ours. The copy therefore never
carries database FILES at all — the same exclusion the fossil case already
needed, applied unconditionally — and a backup directory holds one plain
`whiteboard.db`. A snapshot that fails fails the backup: reporting success
over a directory of blobs and no rows is the defect this ADR opened with.

**The stop-the-server requirement is gone.** Three things had to hold, and the
last two were found by measuring rather than by reading:

1. The rows are snapshotted rather than read out from under a writer.
2. Every write into the data directory lands atomically. Uploads used a plain
   `writeFile` like blobs did — measured, a copy overlapping an in-flight 8 MiB
   upload captured a torn file 2 times out of 10, which is worse than always,
   because the backup then holds a corrupt image only sometimes.
3. Nothing DELETES while the copy runs. A backup is a snapshot plus a copy,
   two moments; a file-GC pass unlinking between them removes a file the
   snapshot still references. `backup-in-progress.json` is how the host-side
   backup process tells the daemon's GC to stand down — the filesystem is the
   only channel between them. It fails OPEN, the opposite of every other guard
   here: wrongly believing a backup is running means GC never collects again,
   an unbounded disk leak from a file nobody maintains, while wrongly believing
   none is running costs one skipped stand-down in a window of seconds.

Enabling this is also what would have started leaking a credential. The
daemon record holds the Bearer token and is written owner-only; it was simply
never present during a backup while backups required a stopped server. It is
now excluded, as is the marker itself. Neither unit tests nor review found
that — running the real command against a real daemon did.

### 4. Backup is scheduled by default; the CLI triggers the same pass

What an operator wants is not a command they must remember to run. It is for
this to be handled. So the scheduled pass is the mechanism, and
`whiteboard server backup` becomes a manual trigger of that same pass rather
than a second, differently-shaped implementation of it.

The explicit command keeps its value — migration, support, taking a copy
before a risky change, and a one-shot in an environment with its own
scheduler — but it stops being the only way anything gets backed up.

The periodic-pass shape already exists twice in this codebase
(`file-gc-sweeper` and `workspace-tail`): a completion-rescheduled unref'd
one-shot, off unless configured, strict interval parsing. This is not new
machinery, and it should not be built as though it were.

### 5. A blob's durable copy is a mirror, and the mirror never deletes on garbage collection's behalf

Blobs are content-addressed and immutable, so their durable copy is a
continuous mirror, not a periodic snapshot. But the blob *store* and the blob
*backup* are two roles, and an S3 bucket can be either. Conflating them is
what creates the ordering hazard below, so they are named separately:

- The **blob store** is where blobs live now. File-GC deletes from it, exactly
  as ADR-0020 left it — catching up first, standing down if the record moved.
- The **blob backup** is append-only. **File-GC never deletes from it.**

Nothing about GC changes. That is deliberate: GC's fencing was hard-won in
ADR-0020 and reopening it to teach it about backups would put the two most
destructive passes in the system into one interaction.

### 6. A backup is valid over an interval, and both ends are enforced

This is the open question this ADR was written to answer, and it has two ends
rather than one.

A row snapshot taken at T references blobs. For it to be restorable, every
blob it references must be in the blob backup — and must still be there when
someone restores.

- **The near end (the mirror must be ahead).** If the mirror lags, a snapshot
  at T may reference a blob written just before T that has not been copied
  yet. **A snapshot is therefore not offered for restore until the mirror
  confirms it has passed T.** Until then the backup is incomplete, and must be
  labelled so — an incomplete backup presented as a complete one is the same
  defect this ADR opened with, in a new place.
- **The far end (retention must not delete behind).** A blob that no live
  document references any more is still referenced by every retained snapshot
  taken while it was live. So deletion from the blob backup is governed by
  **snapshot retention**, never by liveness in the current document. The
  retention pass is the only thing that deletes from the blob backup, and it
  deletes only what no retained snapshot references.

Stated once: **a backup is valid from the moment the mirror passes its
snapshot until the moment its snapshot leaves retention, and nothing may
delete inside that interval.** Both ends are enforced explicitly, because both
failures are silent — the near end produces a backup that cannot be restored,
the far end produces one that could be restored yesterday and cannot today.

Read as one sentence it is a containment — `snapshot.refs ⊆ backup`, held for
as long as the snapshot is on offer — and the two rules are the two directions
that containment can be broken. That is why it is **one** property rather than
two rules, and it is executable: `backup-retention.ts` holds the two
predicates, and `backup-retention.property.test.ts` is an `fc.commands` model
that asserts *every offered snapshot is restorable* after each step of any
interleaving of writes, mirroring, sealing, GC, retention and expiry. Neither
boundary is violated by the step that violates it — sealing early is harmless
until a later expiry removes the evidence, deleting early is harmless until
someone restores — so only a sequence catches either.

**The property's own first version tested only half of it, and looked
identical to one that tested both.** A mutation deleting the *entire* blob
backup went undetected: the generator reached a retention deletion often
enough for a naive `retentionDeletes > 0` guard to read healthy, but never
reached one *while a snapshot with real references was on offer*, which is the
far boundary's only interesting arrangement. Two model defects caused it —
snapshots were allowed to reference nothing, and the backup cycle only ever
added references, so every newer snapshot referenced every older blob and
nothing was ever collectable. The guard is now the arrangement itself
(`retentionUnderOffer`), not the count of deletions.

## Consequences

### Easier

- Backup becomes regular without an operator doing anything, which is the only
  version of backup that protects anyone.
- No downtime to take one. The self-hosting guide stops instructing a
  `docker stop`.
- Adding an S3-compatible blob store becomes an implementation of an existing
  role rather than a new hole in an existing operation. This is the reason
  this ADR comes before that work.
- A store the product does not cover is visible in the output instead of
  silently missing.
- The first slice of decision 1's per-store record already ships, ahead of the
  rest of this ADR, because the narrow guard could not be made correct without
  it. `<dataDir>/storage.json` records one boolean — whether this deployment's
  rows are in the data directory — written by whoever opens the database and
  deliberately never removed. It is what closes the stale-`whiteboard.db`
  case: an operator who moved the rows to a libSQL server but left the old
  file in place defeats both other sources, because the environment a
  host-side backup reads is the invoking shell's rather than the deployment's,
  and the directory cannot tell a live database from a fossil. The record is
  consulted first and the environment remains the fallback for a deployment
  that has never opened one, so no existing install is made worse.

  Restore does not get the symmetric check, though writing one is the obvious
  move. It only ever writes into an empty or missing target, so a target
  cannot be holding a record to read — the check would be unreachable, and
  would pass a test suite that mocks the restore where the emptiness
  rejection lives. `server-restore.test.ts` pins that reason rather than
  leaving the asymmetry to look like an oversight.

  It carries no connection string. The file sits in the directory a backup
  copies wholesale, a URL can carry userinfo, and one boolean answers the only
  question asked of it. Widening it to describe blob and version stores is
  what decision 1 still has left to do.

### Harder

- More moving parts than one `cp`, and two of them (mirror progress, retention)
  have to be right or the interval in decision 6 is not actually held.
- The retention pass is a second destructive pass in a system that already
  has one. It is deliberately kept away from file-GC, but it still needs its
  own fencing and its own evidence that it stands down when it should.
- "Is my backup good?" becomes a question with a per-store answer, which is
  more honest and less immediate than one boolean. The output has to be built
  so an operator can still read it at a glance.

### Not addressed here

- **Restore across a configuration change** — restoring a backup taken with an
  embedded database into a deployment using a libSQL server, or vice versa. It
  is a real operator need and this ADR does not answer it.
- **Encryption at rest of the durable copy**, and credentials for the
  destination. Deliberately deferred: it interacts with the hosted-deployment
  secret story rather than with this one.
- **What the operator-facing configuration surface actually looks like** —
  the setting names themselves. Doing that one environment variable at a time
  while implementing S3 is precisely what this ADR exists to prevent.

  What IS settled is the rule those settings will follow: **an unset setting
  takes its default; a setting that is present but cannot be understood
  aborts startup.** Setting a value is how an operator states a requirement,
  and starting on the default answers it with behaviour they did not ask for
  while saying so nowhere — `WHITEBOARD_FILE_GC_GRACE_MS=1h` meant one
  millisecond, and the window protecting an in-flight upload was gone with no
  error anywhere.

  This is not a new posture. `server/index.ts` already fails fast on a
  malformed `WHITEBOARD_ALLOWED_WEB_ORIGINS` and OAuth client registry, for
  the reason its own comment gives — a silent fallback "would look identical
  to 'the operator never configured it'". The storage settings had simply
  never been held to it, and had drifted into four different answers for a
  malformed value: default, `Number.parseInt` prefix, off, and abort.
  `storage-env.ts` is now the one definition of each rule, used by both the
  startup gate and the call sites.

## Alternatives considered

**Keep the whole-directory copy and require the database to be inside it.**
Simplest, and it is what the narrow guard currently enforces. Rejected as a
destination rather than a stopgap: it forbids the multi-instance deployment
ADR-0020 was written to enable, and it keeps the stop-the-server requirement
that makes backups rare.

**Teach the whole-directory backup to also dump a remote database.** Keeps one
operation. Rejected because it is decision 2 in reverse — the product would
own a poor reimplementation of every provider's PITR, and would own it
forever.

**Make file-GC retention-aware, so it refuses to delete a blob any retained
snapshot references.** Attractive because it needs no second pass. Rejected:
it puts backup retention inside the most destructive pass in the system, whose
fencing ADR-0020 established carefully, and it makes every GC run read every
retained snapshot. Decision 5's split achieves the same guarantee by letting
GC stay exactly as it is.

**Snapshot the rows by stopping writes briefly instead of `VACUUM INTO`.**
Would work, and is what a filesystem-level copy would need. Rejected on the
measurement above: the database can be snapshotted hot, so buying consistency
with a write pause is paying for something already free.
