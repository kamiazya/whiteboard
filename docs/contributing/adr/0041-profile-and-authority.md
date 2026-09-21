# ADR-0041: A profile is a per-keeper claim, and authority reaches resources but not identity

**Status:** Accepted — human gate 2026-09-19. S8 slices 1-4 are implemented
(see the 2026-09-21 addendum below for what each closed): the `workspaceAccess`
gate now reaches the replica-key route and every other online route in
local-daemon mode, with a dedicated page for both a removed member and a
session that has not yet bound its passkey. Completes [ADR-0039](0039-passkey-attestation.md) decision 9's
profile and settles the direction its 2026-09-17 revision recorded. Stands on
[ADR-0035](0035-device-keys-and-keeper.md) decision 4 (a keeper is not an
issuer) and rides [ADR-0023](0023-replica-model.md)'s keeper model rather than
adding a second one. The propagation of a revocation to a replica that is
offline — the one real conflict with local-first behaviour — is
[ADR-0042](0042-offline-revocation.md), taken the same day on an axis this ADR
did not anticipate.

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

- **Revocation reaching an offline replica** — [ADR-0042](0042-offline-revocation.md),
  decided the same day: the policy chooses whether a replica exists, and where
  one does it is encrypted at rest under a key the keeper withholds on
  revocation. Cryptographic rather than advisory, and not E2EE — the keeper
  holds the plaintext either way.
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

## Addendum (2026-09-21): membership gates ONLINE access, not just the replica

S8 slice 1 landed the one decision (`workspaceAccess`) but wired it into a
single route — the replica key. That left an L1 revoke able to kill a
removed person's OFFLINE key while their still-valid pairing token kept
reading and writing every other route live. Slice 2 closes that: every
document, sync and workspace-listing route in local-daemon mode now runs
the same decision, gated on whether the target workspace has any members
at all.

**The reading confirmed**: this is a **pairing-lane** decision, not a
membership-everywhere one. Every operator-issued credential kind
(`anonymous`, `daemon-token`, `oauth-grant`, `macaroon`, `ws-ticket`) stays
exempt, because none of them can name a PERSON — decision 4's own point,
restated for the online surface. A member-less workspace — no member ever
added — keeps origin trust unconditionally, so the ordinary single-daemon,
single-user setup this project ships by default is unaffected.

**Options considered and not chosen:**

- **Person-required everywhere, even for operator-issued credentials.**
  Would make the daemon token, an open daemon, and a macaroon all subject
  to a passkey check they have no way to satisfy — a permanent lockout the
  moment any workspace on the daemon gains a member, including for the
  operator who runs it. Rejected for the same reason decision 4 exempts
  them from L1 in the first place.
- **Revoking the origin's pairing grant on L1 removal**, rather than only
  ending bound sessions and refusing future membership-gated requests. This
  would cut the removed person's browser off from the DAEMON, not just
  from the workspace they were removed from — collateral damage to every
  OTHER workspace that origin can still legitimately reach (including a
  member-less one). Rejected: L1 is per-workspace, and the blast radius of
  its enforcement should be too.
- **Offline-only enforcement** (the pre-slice-2 state, kept deliberately
  minimal for slice 1 while the online story was designed). Rejected as
  the end state once the online gap above was named: a revoke that bites
  only the copy stored for offline use, while the same removed person
  reads and writes live through every other route, is not the revocation
  ADR-0042 decision 3 describes.

**Slice 3 (same day) closed the deferred item above.** The daemon page now
reads the refusal by CODE (never by matching its message) and answers the
two it acts on differently: `not_a_member` lands on the same "you were
removed" page ADR-0042 decision 4 describes — reached now from the online
routes too, not only from an offline replica — while
`requires_person_session` (a session that has simply never bound its
passkey yet) gets a once-only retry prompt instead of either error page.
Every other refusal code still falls through to the generic daemon-page
load error, unclassified.

**Slice 4 (2026-09-21): a workspace that once had members stays
person-gated.** `workspaceAccess`'s member-less arm read
`listMembers(workspaceId).length === 0`, so removing a workspace's SOLE
member returned it to origin trust — the just-removed origin's own pairing
grant got every online route back (`scripts/smoke/mcp-read-plane-smoke.mjs`
check 4, run against a real daemon, found documents/snapshot/replica-key
all answering 200 after the removal). The user chose **"a workspace that
once had members stays person-gated"**: a `workspaceMembersOnly` marker,
outside the CRDT-synced record beside the membership rows (migration
`0030-workspace-members-only`), set once by `addMember`'s first insert and
never cleared by `revokeL1Membership`. `workspaceAccess` now reads the
marker instead of counting members; removing every member leaves the
workspace admitting NOBODY until a member is added again.

Two alternatives were considered and rejected in favour of the marker:

- **Refuse removing the last member.** Rejected — an admin locked out of
  their own passkey would have no way to reopen a workspace at all, and
  "you may not remove the last member" is a surprising rule to hit only
  once, on the person's way out.
- **Accept the reversion and fix the smoke to expect it.** Rejected — the
  smoke was reporting a real gap, not a wrong assertion; patching the test
  to match the gap would have re-opened exactly the S8-slice-2 mistake this
  ADR's own addendum above describes (a revocation that bites one surface
  and waves the same person through every other).

The marker's own honesty has a limit, stated rather than hidden: the 0030
migration backfills one row per workspace that already has a membership row
when it runs, `since` the earliest of that workspace's memberships — a
workspace whose members were ALL removed BEFORE 0030 ran has no membership
row left to backfill from, and stays origin-trusted. That history is not
recoverable.

**Slice 5 (2026-09-21): the gate gets its exit, and the exit is barred by
grant KIND.** Slice 4 above closed by saying "reopening a member-gated
workspace to origin trust is a later product decision; nothing in this
slice builds a control for it". It is built now. `DELETE
/api/workspaces/:workspaceId/members-only` clears the marker and answers
what the marker WAS, so an operator asking twice can tell "I just reopened
it" from "it was already open". Memberships are left in place: reopening
widens who may read and does not remove who already could, and folding
those together would make one call two decisions with the second one
silent. A workspace re-closes on its next `addMember`, so this is a
one-shot rather than a mode a workspace sits in.

The user stated no preference between the candidate designs, so the
recommendation stood: **a daemon-token-only operation, with no browser
UI.** What makes that expressible is `route-scope-registry.ts`'s
`daemon-token-only` decision, which until now no route produced — it was
kept "as defense-in-depth for a future daemon-authority route", and this is
that route.

**The bar is by KIND rather than by scope, and that is forced rather than
chosen.** A pairing grant carries every scope (`credential-resolver.ts`),
which this ADR's slice-4 text above already records as the accepted v1
posture. So `runtime:admin` — the bar the member routes beside this one use
— would let any paired browser reopen the very gate that exists to stop an
origin being trusted: a scope-based bar here would be no bar at all.
`grantCoversRoute` refuses `daemon-token-only` for every kind but the
daemon token and `anonymous`, pairing grants included, so the party who can
reopen a workspace is whoever owns the data directory. Proved rather than
asserted: `membership.test.ts` refuses a macaroon that HAS `runtime:admin`
on this route while the suite beside it admits the same token on the member
routes, and mutating the bar to `always('runtime:admin')` turns exactly
that case red.

Two honest limits. The route is **unreachable in server mode** by
construction (no daemon token exists there), which matches — the membership
router is local-daemon-only already. And **nothing records that a reopen
happened** beyond a `notice` log line; there is no audit log in this
codebase to write to, and inventing one in passing would make it the
convention by accident.

Also unchanged by this slice: the 0030 backfill limit above. A workspace
whose members were all removed before 0030 ran is origin-trusted and needs
no reopening.
