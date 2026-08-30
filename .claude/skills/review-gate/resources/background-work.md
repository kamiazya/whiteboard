# Background Work

Work the server does on its own — a scheduler, a sweeper, a poller, a
dispatcher — and blocking work on the path that serves requests.

This dimension exists because both of its questions are invisible to every
other one. A background worker that runs on every instance is correct, passes
its tests, and behaves exactly as designed; it simply does the work N times,
and on a multi-instance deployment its retention or cleanup pass deletes from
a set the other instances are changing. A blocking call reads identically to a
non-blocking one — an `await` on a native binding and an `await` on a socket
are the same line — so nothing in a diff shows that the daemon stops serving
for the duration.

Both were got wrong on one worker in this repo: the scheduled backup ran on
every instance and inside the serving process, where its `VACUUM INTO` blocks
the event loop for 1242ms at a 103MB database and 4767ms at 421MB.

Most diffs have nothing here. Say `notApplicable` and move on — that is the
expected answer, and it is cheap. Do NOT stretch to find something: this is
not a general "is it fast enough" review.

## Criteria

### 1. New recurring work is declared, and the declaration is answered honestly

Applies when the diff adds anything that runs without a request: a
`setInterval`/`setTimeout` loop, a cron schedule, a queue consumer, a watcher,
a dispatcher.

Check:
- Is it declared in `packages/mcp-server/src/server/background-work.ts` and
  armed through `startBackgroundWork`, rather than started directly?
- **`instances`** — `leader-only` names the lease; `every-instance` gives a
  reason. Judge the reason, do not just confirm one is present. Is it a real
  argument (the work is per-process, or cheap and idempotent, or ADR-0020
  rejects a leader for this specific case) or is it a restatement of what the
  code does? `every-instance` with no argument is the default a worker gets by
  accident, and it is the finding this criterion exists for.
- **`loop`** — `in-process` carries a MEASURED `measuredBlockMs` and a date.
  Was it measured, or estimated? A round number with no accompanying test,
  script, or commit-message figure is a guess wearing a measurement's clothes.
  `measureLoopAvailability` (`shared/test-utils/loop-availability.ts`) is what
  produces it; a hand-rolled sampler that records nothing reports total
  blockage as zero, which is how this was got wrong the first time.
- Does the diff remove a worker without removing its declaration, or leave a
  declaration whose `worker` is `null` with no reason given?

### 2. Nothing newly blocks the serving loop

Applies when the diff adds work to a path the daemon runs: a route handler, a
WebSocket frame handler, an MCP tool, or a background worker declared
`in-process`.

Check:
- A synchronous filesystem call (`readFileSync`, `writeFileSync`,
  `existsSync` on a hot path), `execSync`/`spawnSync`, or a synchronous
  crypto/compression call over data whose size the caller does not bound.
- A native-binding call whose cost scales with stored data — the database
  driver, image rasterisation, WASM. These are the ones that look async and
  are not; `snapshot-blocking.test.ts` is the pattern for pinning one.
- A loop over an unbounded collection (every workspace, every document,
  every version) with no yield between iterations.

A finding here is not "this is slow". It is "this stops the process serving
anything, and nothing in the diff says so". If the cost is real and accepted,
the finding is that it is undeclared, and the fix is a measurement plus either
a subprocess or a stated figure.

### 3. Coordination is rented, not written

Applies when the diff adds anything that decides which process does something.

Check:
- ADR-0020 requires the mechanism be rented — a `leases` table, an advisory
  lock, a Kubernetes `Lease` — never a bespoke implementation. A new mutex,
  election, or "am I the primary" flag written by hand is a finding.
- Is liveness time-based? A pid, a hostname, or a local file lock means
  nothing to a process in another container, which is the deployment this
  coordination exists for.
- Is the failure direction stated and right? Work that duplicates harmlessly
  can fail open; work whose duplication corrupts or deletes must fail closed.
