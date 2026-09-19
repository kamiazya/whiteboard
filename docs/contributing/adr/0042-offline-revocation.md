# ADR-0042: Revoking access to a replica that is offline

**Status:** Proposed — the question, its options and what would settle it.
**The choice is deliberately not taken** (owner, 2026-09-19): the trade is
real, and the deployment evidence that would decide it does not exist yet.
Split out of [ADR-0041](0041-profile-and-authority.md), which decides
everything about profiles and authority that this one does not.

## Context

ADR-0041 decision 3 gives a keeper two revocations over its own resource: L1,
access to a workspace, and L2, acceptance of a credential. Both are a state
change at the keeper. Neither says what happens to a holder that is not
listening.

[ADR-0023](0023-replica-model.md) decision 2 makes a replica readable while
the keeper is unreachable — "warm start, and offline availability when the
daemon is unreachable". That is a feature, and it is the direct obstacle:

| holder | when the revocation takes effect |
|---|---|
| the keeper itself | immediately |
| a connected replica | at its next sync |
| a disconnected replica | **never, until it reconnects** |

An enterprise that says "revoke immediately" is asking for the third row to
stop being true, and the only way to make a disconnected holder stop reading
is to have given it permission that expires.

### Why this cannot be answered by argument

Both sides are load-bearing project commitments, not preferences:

- offline readability is what "your data survives the infrastructure dying"
  means in practice, and ADR-0023 spent a whole decision implementing it;
- a revocation that a laptop in a bag can ignore for a month is not a
  revocation an auditor will accept.

Nothing in the current codebase measures which one costs more, because the
product has no deployment with a compliance requirement attached to it. A
decision taken now would be taken on taste.

## Decision

**Not taken.** What this ADR fixes instead is the shape of the question, so
the next person does not restate it, and the evidence that would settle it.

### The options, as they stand

**A. No expiry.** A replica reads until it reconnects. Revocation is
eventual. The current behaviour, and the only one that costs nothing.

**B. A lease with a TTL.** A replica carries permission valid for a bounded
period and stops serving reads when it lapses without renewal. The TTL is the
whole design: it is the worst-case exposure window and the offline working
time, and those are the same number read from two sides.

**C. Per-deployment, defaulting to A.** The lease exists but is off unless a
deployment turns it on, so a compliance requirement can buy the guarantee and
nobody else pays for it. Costs a second code path that is rarely exercised —
which is exactly the kind of path that rots quietly.

### What would settle it

Before choosing, the following are worth having and are all cheap next to the
implementation:

1. **A named deployment with the requirement.** Written down: the TTL it needs,
   and whether it is a policy the organisation states or a regulation it cites.
   Without one, B and C are speculative.
2. **What offline time real use actually takes.** If the honest figure is
   hours, a lease is nearly free; if it is days on a plane, B is a product
   regression sold as a security feature.
3. **What a lapsed lease does to the UI.** "Cannot reach the keeper" and
   "you have been cut off" must not look the same, and a replica that goes
   blank at hour 24 with no explanation is worse than either option.

## Consequences

- ADR-0041 ships without waiting, because L1 and L2 at the keeper are useful
  from the first connected sync regardless of what is decided here.
- Anything sold as "immediate revocation" is unsupported until this is
  decided, and saying so is part of the honesty this project keeps about
  shipped state.
- Should B or C be taken, it lands as an amendment or a superseding ADR with
  the evidence above attached, not as an implementation detail of a release.

## Alternatives considered

**Deciding it inside ADR-0041.** Rejected by the owner. It is the only part of
that work with a genuine conflict against a standing commitment, and bundling
it would have made a settled design wait on an unsettled one.

**Leaving it as a paragraph in ADR-0041's deferrals.** Rejected here: the
analysis above — three options, three pieces of evidence — is more than a
deferral note carries, and a deferral with no home is where a question goes to
be asked again from scratch.
