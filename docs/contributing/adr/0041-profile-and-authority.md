# ADR-0041: A profile is a per-keeper claim, and authority reaches resources but not identity

**Status:** Accepted — human gate 2026-09-19. Design of record; nothing
implemented. Completes [ADR-0039](0039-passkey-attestation.md) decision 9's
profile and settles the direction its 2026-09-17 revision recorded. Stands on
[ADR-0035](0035-device-keys-and-keeper.md) decision 4 (a keeper is not an
issuer) and rides [ADR-0023](0023-replica-model.md)'s keeper model rather than
adding a second one. The propagation of a revocation to a replica that is
offline is deferred to [ADR-0042](0042-offline-revocation.md), which is where
the one real conflict with local-first behaviour lives.

## Context

ADR-0039 decision 9 put the device→user table in a "profile" and did not say
who keeps it. Its 2026-09-17 revision gave a direction — each keeper may hold
a record, and a higher-authority one takes precedence — and left it to be
recorded here.

### The first framing of this was wrong, and the mistake is worth keeping

The draft that went to the gate said authority may decide **presentation and
reconciliation only**, and may not revoke anything, because ADR-0035 decision
4 forbids a server becoming an issuer. The owner's correction: an enterprise
deployment has to be able to revoke, and a server's authority comes from
**owning the resource**.

Both halves of that are already in decision 4's own text, which says sharing
and governance are "authority over a **resource**, not a claim about an
**identity**". The draft had collapsed three different things into one word:

- cutting a person off from a workspace,
- refusing a credential,
- declaring that a person does not exist.

Only the third makes a server an issuer. The first two are exactly what a
keeper is for, and one of them already ships. Writing "revocation" without a
target is what made a requirement look like a conflict.

### The keeper model already carries most of this

ADR-0023 decision 1 gives every workspace exactly one keeper, with every other
holder a replica that is "readable, overwritten by sync, never authoritative",
and decision 2 makes `promote`/`demote` the move. That is an authority order
over a resource, already decided and already implemented. What was missing was
not a mechanism but a policy: who may move it, and who may cut whom off.

### What a profile may not become

ADR-0035 decision 2 admits only an identifier that survives key rotation into
content, and until a user DID method is chosen, version rows carry the device
DID alone. A locally minted person identifier does not survive being moved, so
it stays out of documents. This ADR must therefore describe a profile that is
useful while being invisible to the content plane.

## Decision

### 1. A profile is a claim held by a keeper, not a record with one home

Each keeper — a browser's own storage, a daemon, a server — may hold a profile
record for a person: a locally minted identifier, a display name, and the
credential ids it accepts as that person's. Several keepers holding different
records for the same person is the normal state, not a fault to be repaired.

A profile holds no private key. The browser's signer is a WebAuthn credential
(ADR-0035 decision 1's 2026-09-16 addendum), and a credential id is a public
handle.

### 2. Authority is an order over keepers, and it decides two things

Where records disagree, the higher-authority keeper's record wins for:

- **presentation** — which display name a reader is shown;
- **reconciliation** — which credentials are treated as one person.

That is the whole of what the ORDER decides. It is not what decides who may
read a workspace; that is decision 3.

### 3. Revocation has three layers, and the top one has no owner

| | what is revoked | who may | example |
|---|---|---|---|
| **L1** | access to a resource | the workspace's keeper | remove a leaver from an organisation workspace |
| **L2** | acceptance of a credential | the keeper that pinned it | cut a lost device |
| **L3** | the person's existence | **nobody** | "this person is not real" |

L1 and L2 are a keeper's ordinary authority over its own resource, and are
what ADR-0035 decision 4 calls governance. L2 already ships: the daemon's
`/api/pairing/credentials` routes landed in #1610 and Settings › Connections
gained the screen in #1627.

L3 is what makes a party an issuer, and an issuer is a dependency that cannot
be removed — "your data survives the infrastructure dying" stops being true
the moment the party that vouches for you can un-vouch. No keeper gets it, at
any authority level, under any configuration.

**An enterprise needs L1 and L2 and does not need L3.** Cutting off a leaver,
handling a lost device and satisfying an audit are all resource-scoped. L3
would be needed only to erase a person, which is not this product's job.

### 4. The identifier is minted low, linked upward, and never written into content

A person identifier is minted by whichever keeper first needs one — in
practice the browser. A higher-authority keeper links to it rather than
replacing it, so a record stays resolvable when the keeper above it is gone.

It is not written into documents or version rows. ADR-0035 decision 2's rule
stands unchanged: content carries the device DID, and a surface that wants a
person's name resolves it through the profile at read time. Nothing in this
ADR unblocks the user DID method, and nothing here depends on it.

### 5. The authority order is configuration, scoped per workspace

A server is a keeper whether it was stood up for one person or for a company,
so the order is a deployment policy rather than a property of being a server.
It is scoped per workspace for the reason ADR-0023 decision 1 scoped the
keeper per workspace: an individual's own workspaces and an organisation's
live in the same app, and a single global setting would name a mechanism
nobody can evaluate.

Three shapes this is expected to take — a default set, not an enumeration:

| | organisation workspace keeper | who may move it | who may issue L1/L2 |
|---|---|---|---|
| personal | whichever the user chose | the user | the user |
| team | the server | an administrator | an administrator |
| enterprise | the server, pinned | an administrator only | an administrator, immediately |

### 6. The right to leave belongs to whoever owns the resource, not to every replica holder

Making the move itself subject to authority is self-referential: once a
workspace is promoted to a server, a server that refuses to release it is
never released, and a personal server could not be wound down.

The resolution is that `demote` is available to **the party the resource
belongs to**, and that party is not every holder of a replica. An individual
may always demote their own workspace and keep their data. A member of an
organisation may not demote the organisation's workspace — that would be L1
inverted, a way to walk off with what an administrator can otherwise revoke.
The organisation, as owner, keeps the same right at its level: it can move its
workspaces off a SaaS.

ADR-0023 decision 2 is already the shape this takes — verify the destination
holds everything, then release — so this is a rule about who may invoke it,
not a new mechanism.

### 7. Linking two identifiers is an explicit operation, never an automatic join

A shared credential is good evidence that two profile records describe one
person, and it is not a decision. An automatic join is a silent merge of two
identities whose reversal is ambiguous — after the merge, which rows named
whom? So a shared credential may **propose** a link in a UI, and a person
confirms it.

The cost is accepted deliberately: the operational effort of confirming is
smaller than the cost of an unwind, and a confirmation leaves a record that an
inferred join does not.

## Consequences

### What this makes possible now

- An enterprise deployment can cut a leaver off and refuse a lost device
  without the product acquiring an identity provider.
- A personal server can be wound down with the data coming home, because the
  right to leave is attached to ownership rather than to authority rank.
- The History row's name (ADR-0039 decision 9) has a defined source when
  several keepers disagree.

### What is deferred, and what triggers it

- **Revocation reaching an offline replica** — [ADR-0042](0042-offline-revocation.md).
  A replica that is readable while disconnected is an ADR-0023 feature, and an
  immediate-revocation requirement wants a lease that takes it away. Deferred
  because the trade is real and the deployment evidence to settle it does not
  exist yet.
- **The user DID method** stays deferred with ADR-0035 decision 2's trigger.
  This ADR is written so that nothing waits on it.
- **The concrete policy surface** — how an administrator states an order — is
  an increment, not a decision here.

### What gets harder

- Two names for one person is now a state the UI must render rather than an
  inconsistency to fix, and every surface that shows a name has to resolve it
  the same way.
- "Revoke" is no longer a single word in this codebase. A route, a button or a
  log line that says it without naming L1 or L2 is ambiguous, and the three
  layers have to stay legible in the vocabulary.

## Alternatives considered

**Authority decides presentation and reconciliation only.** The first draft.
Rejected on the owner's correction: it cannot express an enterprise's L1/L2
requirement, and it withheld from a keeper what decision 4 already grants it.

**A higher-authority keeper may invalidate a lower profile.** This is L3 by
another name. Rejected because it makes the server an issuer and costs the
property ADR-0035 decision 4 exists to protect.

**One global authority setting for a deployment.** Rejected for ADR-0023
decision 1's reason: individual and organisational workspaces coexist, and a
setting above them both would force one policy onto work that has two owners.

**Automatic identity join on a shared credential.** Rejected in decision 7 —
convenient, and it makes a silent merge whose unwind is ambiguous.
