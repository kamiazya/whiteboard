# ADR-0039: A passkey attests a person's presence, not a device

**Status:** Proposed. Extends [ADR-0035](0035-device-keys-and-keeper.md) and amends
the scope of its decision 1. Nothing implemented. Revised 2026-09-16 after
review split "verified" into a CLAIM and its EVIDENCE — decisions 5, 8 and 9,
and the second paragraph of decision 2, are that revision; the first draft's
decision 5 is kept under *Revisions* because the correction is the point.

## Context

ADR-0035 deferred "a browser profile's own keypair" without a trigger. Three
product moments supply one, and they are the only moments where a signature was
ever wanted:

1. **A browser-kept workspace is being connected to a daemon.** Promotion today
   is `promote-workspace.ts` POSTing the record's snapshot to
   `workspace-document/update` — that POST *is* the CRDT merge. The daemon
   accepts bytes it never witnessed, from a keeper it cannot check.
2. **A local in-browser AI becomes a second actor.** Today the browser writes
   `{ kind: 'human' }` or `{ kind: 'system', displayName: 'auto-save' }` and no
   `actor` at all, so nothing distinguishes what a person wrote from what an
   agent on the same page wrote.
3. **A user asks for content to be readable only after user verification.**

None of the three wants a signature on every checkpoint. Each is a moment a
person chose, which is what makes a mechanism requiring a gesture viable here
and not elsewhere.

### The shape that looks obvious is the shape already removed

`browser-idb.ts`'s v5 -> v6 migration DELETES the `reconnectKeypairs` store, and
says why: a non-extractable `CryptoKey` need not be exfiltrated to be abused,
because same-origin script can call `crypto.subtle.sign()` with it directly.
`docs/explanation/security-model.md` generalises it — a browser origin belongs to
whatever process later claims that port.

For an attestation key the consequence is sharper than for the access credential
that lesson was paid on. The same document states that a browser keeper's
content in IndexedDB is likewise readable by a later occupant of the origin, with
"no equivalent fix available"; same-origin script can rewrite it as easily as
read it. So a key stored beside the content can be invoked by exactly the party
who can also forge the content it would attest. Such a signature proves nothing,
and is worse than none: it dresses forged content as attested.

### What the platforms actually do, checked rather than recalled

ADR-0035 flagged its own WebAuthn facts as current to 2026-05 and asked for
re-checking. Checked 2026-09-13:

- **PRF is broadly available on platform authenticators.** Safari 18+ derives a
  secret from an iCloud Keychain passkey; macOS 15 brought platform support;
  Firefox 139+ on platform authenticators, with Windows Hello handled from 148;
  Chrome 147 enabled PRF-on-create on Windows by default. Apple still does not
  pass extension data to *roaming* authenticators on iOS/iPadOS.
- **Backup eligibility is observable and permanent.** `BE` (flags bit 3) says
  whether a credential may ever sync and is fixed for its life; `BS` (bit 4) says
  whether it is backed up now and may flip. `BE=0` is a device-bound credential,
  `BE=1` a syncable one, and `BE=0, BS=1` is invalid and must be rejected. Both
  bits arrive in the authenticator data of every registration and assertion.
- **A relying party cannot make a credential device-bound.** Requesting a
  resident key on a platform with a cloud keychain produces a synced passkey;
  Apple leans hard enough that creating a device-bound passkey via WebAuthn on
  iOS is reported as impossible. Windows Hello's own credentials remain
  device-bound, but Edge now offers synced ones through its password manager.

That last point decides the shape of this ADR rather than being a detail in it.

## Decision

### 1. A browser profile stores no private key

The v5 -> v6 removal stands and generalises: this project does not put a private
key in origin storage, for attestation any more than for access. A signature
producible by whoever can also rewrite the content is not evidence.

### 2. The browser's signer is a WebAuthn credential, and it attests PRESENCE

What a passkey assertion establishes is that a person satisfied user
verification on an authenticator bound to this relying party — not which machine
they were at. The private key never enters origin storage and cannot be invoked
silently, which is precisely why it survives the argument in decision 1.

**This amends ADR-0035 decision 1's scope.** That decision governs keys the
system *stores and uses unattended* — the daemon's. It said keys belong to a
device and never to a user; a passkey may be synced across a person's devices,
and per the measurement above the relying party cannot prevent that. Claiming
this as a device key would be false. So the two coexist by naming different
things: the daemon holds a **device key**, a passkey backs a **person**.

Two things "person" does not yet mean, said here so the word is not read as
more than it is. It is a ROLE, not an identifier: ADR-0035 deferred the user
DID's method and this ADR inherits that deferral, so two passkeys held by one
human — one per relying party, or one before and one after a loss — are
unrelated until the profile that relates them exists. And a passkey-backed row
writes its `actor` as the `did:key` of the credential's public key (P-256 has
a multicodec), which keeps ADR-0035's one notation rather than adding a fourth
— at the cost ADR-0035 already named: a `did:key` says nothing to a human
without the lookup.

### 3. Backup eligibility is recorded, never assumed

`BE` is read from every registration and assertion and stored with the
credential. It is the only honest statement available about whether an identity
is confined to one machine, and it is free. A credential presenting `BE=0, BS=1`
is rejected as malformed.

Nothing is gated on `BE` yet. It is recorded so that a later policy — a stricter
trust tier for device-bound credentials, a warning before a single-device
lockout — has the fact it would need, rather than discovering it is absent.

### 4. An attestation is asked for where impersonation would matter, and nowhere else

No flow asks for a gesture on a schedule, and — the revision — no flow asks
for one on every explicit act either. A save that demanded Face ID each time
is a save nobody makes. The prompt appears where the question "was that really
the person?" has a cost if the answer is no:

| moment | prompt | why |
|---|---|---|
| **promotion** (browser → daemon) | **always** | a trust boundary: the daemon receives content from a keeper it cannot check, once |
| **approving a proposal** | **by workspace setting**, off by default | the moment an agent's change becomes the document; a human approving an agent's work is exactly where an agent approving its own would matter. ADR-0029 is design of record and unimplemented, so only the setting's existence is decided here |
| **saving a version** | **never** | the click is the review (decision 8); evidence on top of it is not worth a prompt |
| automatic checkpoints, agent writes | never | there is no person to ask |

This is what keeps decision 2 affordable; a design that needed a gesture per
save would have to store a key, which decision 1 forbids — or would not be
used.

### 5. `kind` names the actor; an attestation defends the claim where an agent could forge it

On the designed path the actor is what the row SAYS: an agent writes
`kind: 'ai'` with an `agentId`, a person's explicit act writes `kind: 'human'`,
a scheduler writes `kind: 'system'`. That is a self-report, and
[ADR-0016](0016-okf-trust-family.md) admits self-reports because nothing better
existed.

What a passkey adds is a defence on the path that is NOT designed: an
in-browser AI shares the origin, the page and every API the human has, so it
can press the human's button and write `kind: 'human'`. No credential can be
issued "to" the AI that the page cannot also use. What the AI cannot do is
satisfy user verification. So where an agent impersonating a person would
matter (decision 4's table), the row carries an assertion the agent could not
have produced — the first backing for a human claim in this system that is not
a self-report.

The first draft said the *absence* of an attestation marks a non-human actor.
That is false under decision 4: most human rows carry none, by design. Absence
means "not asked", and `kind` still says who.

### 6. A user-verification gate may ship, and its copy says what it does not do

Moment 3 is not attestation, and it is not encryption either. Asking for user
verification before showing a document is a real feature for what it actually
addresses — a shared machine, an unattended screen, someone reading over a
shoulder — and those are the situations most people who want it are in.

What it is not is protection from the scenario `security-model.md` documents.
A process that later owns the origin reads IndexedDB directly and never runs
the app's code, so the check is one it never encounters. Only encryption
reaches that case, and encryption stays deferred below.

Both halves are true at once, so **the copy states both, and is declared in one
place**. `lib/destructive-copy.ts` is the precedent and the shape to copy: a
promise about someone's data, written once and imported at every site, tests
included, with `destructive-copy-surface.test.ts` scanning that it appears
nowhere else. That module exists because the same promise written at several
sites HAD drifted — a correction reached four of the six places carrying it,
and the two it missed were tests asserting a middle fragment.

The promise this one makes is exactly the kind that decays: "requires Face ID"
invites "so it is encrypted", and whoever writes the second surface's copy will
not have read this ADR. So the declaration is the rung, not this paragraph.

**The name must not claim more than the mechanism does.** Words that assert
protection of the data at rest — *encrypted*, *secure*, *protected* — are
unavailable to this feature. What it does is hide content on this screen until
a person verifies, and the name may say that.

#### The gate's scope is every surface that can show the content

The inventory below is what the gate must cover, not only what encryption would
cover later, and it is easy to under-cover because the content reaches a reader
through more than the document view. A gated document must not surface through
the preview pane, the row thumbnail — which `layout-worker.ts` will happily
render from the OPFS cache — or **search results**, whose corpus is built by
reading the document's own body. A gate that hides the canvas and leaves the
body findable is the shape that makes the feature untrue rather than merely
limited.

#### Encryption, deferred, and what it would have to cover

**Trigger:** an explicit user opt-in beyond the gate above, or a keeper the user
does not own. The key is derived at point of use — the PRF case ADR-0035
deferred under E2EE.

The browser keeper persists in two places, and the second is easy to forget
because only one module reaches it. Inventory taken 2026-09-13:

| what | where | kind |
|---|---|---|
| snapshot bytes (`syncSnapshotChunks`), manifest/frontier/delta log (`syncDocuments`) | IndexedDB | content |
| uploaded images (`blobs`) | IndexedDB | content |
| rendered SVG and its bounds (`render/`) | **OPFS** | derived content |
| placement and naming (`documentIndex`, `workspaces`) | IndexedDB | metadata — **names and paths in the clear** |
| a version's `path`, `label`, `operator` (`versions`) | IndexedDB | metadata |
| the search corpus | memory only | not persisted |

Three consequences the table makes concrete:

- **The images are in IndexedDB, not OPFS**, so what must be encrypted is
  almost entirely in one store family. `render-store.ts` is the ONLY module in
  this app that calls `navigator.storage.getDirectory()`.
- **The OPFS render cache need not be encrypted at all.** It is total by
  contract in both directions — a read that fails answers "not there" and the
  caller renders — so the cheaper design is to not write it while locked and
  drop it when the key is absent. Nothing breaks; a picture is recomputed.
- **Encrypting content does not hide a document's NAME.** A board called
  "2026 redundancies" leaks from `documentIndex` and from every `versions`
  row. Whether the locked state hides names is a design question with a real
  UX cost, and it is not answered by choosing a cipher.

#### The search index, which both halves of this decision have to answer for

`local-files-source.ts` builds its search corpus in memory on first query and
carries a `ponytail` note planning to **persist an index** when a measured
workspace makes that slow. Today's in-memory corpus is lucky, not designed —
the note is about latency, and whoever acts on it will be thinking about
latency too.

It bites the gate and the encryption differently, and neither is obvious from
the note:

- **For the gate**, an index built by reading bodies makes a hidden document's
  text findable, which is the scope failure above in its most likely form.
- **For encryption**, a persisted index is a plaintext inverted index of
  encrypted content — the classic way encryption is undone by a later
  performance fix, by someone who never read this ADR.

### 7. An attestation lives beside the content, never inside it

ADR-0035 decision 2 admits into content only an identifier that survives key
rotation. A WebAuthn credential id is scoped to a relying party and dies with the
credential, so it fails that test. Attestations belong on the version row.

### 8. A row's human-reviewed claim comes from the operation, not from the evidence

Saving a version, approving a proposal, promoting a workspace — each is a
person looking at the document and acting on it, which is what OKF §5.3's
`human-reviewed` means. An automatic checkpoint is not. So a version row is
human-reviewed when `operator.kind === 'human'` and `auto !== true`, both of
which the row already carries; an attestation, when present, is EVIDENCE for
that claim and lives beside it, never the source of it.

This is the correction the review made. The first answer to "how does the
human tier get decided" derived it from the attestation, which would have made
every unprompted save unreviewed and every review a Face ID prompt — the
claim and its proof conflated. The user sees them apart: a name, and a badge.

**`trustTier()` and `isHumanActor()` in `packages/model` are unchanged**, and
that was nearly got wrong too. They read an OKF document's `verified` events —
the format's own wire vocabulary, where §5.3 keys the tier off the `human:`
prefix — and that is the right place for a prefix rule to live. What is new is
the derivation over ROWS above, and a projection from it: an explicit human
checkpoint exported to OKF becomes a `verified` event with `by: human:<name>`.
The prefix is a projection target, not a storage rule — ADR-0037's position
applied to trust.

### 9. What a reader is shown is a name and a badge, and the data is shaped by that

Three visual states on a history row: **human**, **human · verified** (an
attestation is present), **agent**, **system**. The user never sees an
`actor` string. So `actor` stays an identity, `attestation` is a separate
optional field on the version row, and the name comes from a profile — set
once, related to the person's passkeys — rather than from a per-row
`displayName` a caller typed. The profile is where ADR-0035's "device→user
table" now lives, with passkeys in the device column; the person's identifier
is minted locally and needs no DID method yet.

## Consequences

### What this makes possible

- Promotion stops being an unverified hand-off. The signed statement is decision
  3's — this presence, at this frontier, over this content digest — and both the
  digest and the frontier already exist on a version row.
- "A human did this, and no agent pressed the button" becomes checkable where
  it matters, and the check costs the reader nothing: the row either carries
  an assertion or it does not. Elsewhere the click stays the review, unprompted.
- Nothing new is stored that a later occupant of the origin can use.

### What gets harder

- **Two origins, two credentials.** A credential is bound to a relying-party id.
  The hosted app and the daemon's loopback origin are different, so a credential
  made at one does not exist at the other. Verification therefore needs the
  public key registered with the daemon — a step adjacent to pairing, and the
  first thing a design increment has to settle.
- **Two signature algorithms.** Platform authenticators sign ES256; the daemon's
  identity is Ed25519. The verifier handles both.
- **The signature is not over the payload.** WebAuthn signs
  `authenticatorData || SHA-256(clientDataJSON)`, with the payload carried as the
  challenge inside `clientDataJSON`. A verifier reconstructs that, and a
  reviewer should expect it to look unlike the daemon's `buildSignedPayload`.
- **Losing the credential ends that identity's future attestations.** Past ones
  verify for as long as the public key is kept. This follows from ADR-0035's
  "no safe way to move a private key" and is not a defect to engineer around.
- **The platform matrix must be verified against real targets before shipping**,
  especially for decision 6. The facts above are dated and second-hand.
- **The gate is a scope problem, not a cipher choice.** Its cost is finding
  every surface that can show a hidden document — the view, the preview, the
  thumbnail, search — and keeping that list true as surfaces are added.
  Nothing mechanical enumerates them today.
- **Names stay readable whichever half ships.** `documentIndex` and every
  `versions` row carry a document's name in the clear, so a board called
  "2026 redundancies" leaks from the list. Whether a hidden document appears
  by name is a UX decision that needs a person, and no cipher answers it.

## Alternatives considered

**A non-extractable `CryptoKey` in IndexedDB.** Rejected in decision 1 — it is
the shape v5 -> v6 deleted, and the attestation case is weaker than the access
case that removal was decided on, not stronger.

**Deriving a key with PRF and storing it for unattended signing.** Rejected: the
derived key lands in origin storage and inherits every property decision 1
rejects. PRF's value is producing a key at the point of use and discarding it,
which serves decision 6 and not decision 2.

**Requiring a hardware security key, so `BE=0` is guaranteed.** Rejected as a
default — it excludes most users to buy a property no named moment depends on.
Available later as an option; decision 3 records the fact that would drive it.

**Signing every checkpoint.** Rejected in decision 4. It needs a stored key,
which is decision 1, and ADR-0035 decision 3 had already scoped attestation to
checkpoints rather than operations.

**Refusing the user-verification gate outright, because it is not encryption.**
The first draft of decision 6 took this position. Rejected: it declines a
feature that genuinely serves the situations most people asking for it are in
— a shared machine, an unattended screen — on the grounds that it fails a
different threat. The honest objection was never to the feature but to the
claim, and a claim is fixable by declaring it once. What the position was
protecting against is real, and is what the naming rule and the copy
declaration now carry.

**Leaving the browser without any identity, and attesting only on the daemon.**
Coherent, and the cheapest option: the daemon is the user's own machine and has
no origin-squatting analogue. Rejected because moment 1 is exactly the boundary
where the daemon has nothing to check, and moment 2 has no daemon in it at all.

## Revisions

**2026-09-16 — "verified" split into a claim and its evidence.** The first
draft's decision 5 read: *"The ABSENCE of an attestation is what marks a
non-human actor … an attested row means a person was present. This is the
first backing for OKF §5.3's human tier that is not a self-report."* Review
asked what an attested row would write as `actor`, and found that
`isHumanActor` keys on a `human:` prefix a `did:key` does not carry — so the
claimed backing never reached the tier. Following that thread: the tier should
come from the OPERATION (a person saving, approving, promoting is a review; a
scheduler is not) and the attestation should be evidence beside it, asked for
only where an agent forging the click would matter. Decisions 4, 5, 8 and 9
and the second paragraph of decision 2 are that revision. Kept here rather
than silently rewritten because the mistake — deriving a claim from its proof
— is an easy one to make again.

## Sources

- W3C WebAuthn Level 3, `BE`/`BS` flags in authenticator data.
- Platform PRF and backup-eligibility behaviour as surveyed 2026-09-13; see the
  Context section. Dated and second-hand — re-verify before building on
  decision 6.
