# ADR-0045: An account is who logs in; a user is who a tenant knows

**Status:** Draft — the shape and its open forks were recorded on 2026-09-23
while the conversation was fresh, and the owner answered all of them the same
day (see **Decisions taken** below). A second round, forced by what the
first round's implementation exposed, added decisions 11-14 the same day,
and a third added decision 15, which makes authentication a seam. Built so far:
decision 8's tenant partitioning (the origin-keyed stores live under their
tenant), and decisions 1-5's account/user split with the migration that
turned each profile into one account plus one user. What plugs into the
seam decision 15 opened is [ADR-0046](0046-external-sign-in.md); the
external-token validation seam it cites still resolves nothing to an
account; and
[ADR-0041](0041-profile-and-authority.md)'s Member/profile remains what ships;
the draft stays a draft until the first increment is built, so that increment
can correct it rather than inherit a record nobody tested. This exists so the
tenant work does not foreclose the split.

## Context

The tenant boundary landed as a database mechanism: a keeper holds tenants
(self-host one, SaaS many), every tenant-scoped table carries the tenant, and
stores reach the database only through a handle bound to one. Classifying
`memberProfiles` and `profileCredentials` forced a question the schema cannot
answer: **is a profile a person, or a person-inside-one-tenant?**

Today it is both at once. `memberProfiles` is minted per keeper
(ADR-0041 decision 1), `profileCredentials` maps a WebAuthn credential to it,
and ADR-0041's Member is "a `MemberProfile` a workspace's keeper has admitted
to that workspace". With one tenant those are indistinguishable. With many,
conflating them decides two things nobody agreed to: that one person's identity
is the same object in every tenant, and that a tenant's admin sees a person who
also belongs to another tenant.

The owner's framing (2026-09-23), when asked whether a profile belongs to a
tenant:

> ややこしいですが、Slackのようにアカウントとユーザーは別の概念でもいいかも。
> あと仕事用とプライベートでアカウントを分けるとかも考慮できるとよいかも。
> とはいえ、Workspaceからやテナントから見たユーザーの単位は変わらない様に
> 設計したいです。

Three things, and the third is a constraint on the other two: an ACCOUNT and a
USER may be different concepts; a person may keep separate accounts (work and
private); and **the unit a workspace or a tenant sees as "a user" must not
change**.

## Decision

1. **A USER is who a person is inside ONE tenant.** This is `memberProfiles` as
   it stands — a display name, and the thing a membership, an attribution, a
   comment author and a version's operator point at. It is tenant-scoped.
   Everything a workspace names keeps pointing here, which is what makes the
   constraint above hold: adding accounts moves nothing a workspace can see.

   This supersedes ADR-0035 decision 1's use of "user" for the set of a
   person's device DIDs: that set stays device evidence, not the product's
   User. It also narrows ADR-0041 decision 1's keeper-held profile: in a
   keeper with several tenants, each profile record belongs to exactly one.

2. **An ACCOUNT is the keeper-wide login identity that one or more
   authenticator bindings resolve to.** A passkey is the built-in
   authenticator and contributes a WebAuthn credential; other authenticators
   contribute a subject of their own (decision 15). An account belongs to no
   tenant. It carries no
   display name a tenant reads, no membership, and no authority of its own —
   authority reaches a resource through a user
   ([ADR-0043](0043-authority-as-keys.md)), never through an account.

3. **An account links to zero or more users, at most one per tenant.** Signing
   in with an account at a tenant resolves to that tenant's user (where the
   sign-in happens is decision 12). A person who wants to be two people in one tenant uses two accounts,
   which is the same answer as "work and private".

4. **Nothing joins two accounts.** A person holding a work account and a
   private one is two accounts to this system, even when the same authenticator
   holds both credentials. Declaring them the same person is exactly what
   ADR-0035 decision 4 says a keeper may not do.

5. **Authentication bindings move under the account, and nothing
   workspace-facing moves.** `profileCredentials` (credential -> profile)
   splits into binding -> account plus account -> user, the second half kept
   inside each tenant (decision 13). For the passkey authenticator a binding
   is the WebAuthn credential; another authenticator's binding is the stable
   subject it reports. That is a change on the authentication side only; the
   workspace-facing unit does not move, per the constraint.

6. **Self-host keeps exactly one account per person and need not show the
   concept.** A keeper with one tenant has one user per account, so the UI has
   nothing to choose between. The split must not add a step to the local
   daemon's pairing flow.

## The forks, as they were posed

Each needed the owner, and each was a real fork rather than a detail. All three
are answered under **Decisions taken**; they are kept as posed because the
alternatives are what the answers were chosen against.

1. **How a request picks its tenant.** By subdomain, by a path prefix, or from
   the account's session (the account names its tenants and one is current).
   The tenant work left this open, and it decides whether `authMode`
   (`'local-daemon'` vs `'server-mode'`) is the discriminator at all.
2. **Whether an account may be admitted to a tenant it has no user in, and by
   whom.** An invitation creates the user; who may send one, and whether an
   account can refuse, is governance and is not settled here.
3. **What a person sees when one authenticator holds credentials for two
   accounts.** Decision 4 says the system does not join them; a passkey picker
   showing two entries for the same face is a UX question that may yet argue
   for naming accounts.

## Decisions taken (owner, 2026-09-23)

7. **A request's tenant is its SUBDOMAIN** — `acme.example.com`, one origin per
   tenant. Chosen over a path prefix and over a session-carried current tenant,
   and the reason is that this codebase already decides trust by ORIGIN: a
   pairing grant is an origin the user approved, and a passkey pin records
   the origin that accepted the credential. (Where a passkey is REGISTERED is
   a separate question, which decision 11 answers.) Under a path prefix every tenant shares one origin, so the browser-side boundary
   disappears and only the server's own check is left; under a session, a
   mistake in that check IS the leak. A subdomain makes the browser enforce
   what the server also enforces. It costs DNS and certificate work for each
   tenant, which is an operator's cost rather than a user's.

   Consequence for `authMode`: `'local-daemon'` vs `'server-mode'` is NOT the
   tenant discriminator. It stays what it is — how the daemon authenticates —
   and the tenant comes from the request's host.

8. **The file-backed stores are partitioned per tenant too**: pairing grants
   and passkey pins move under the tenant's directory, beside its blobs. Once
   decision 7's host routing exists, the host and the storage enforce the
   boundary independently; until then only the storage partition does. Left keeper-wide they would mean "an origin this KEEPER trusts",
   and a grant one tenant gave would answer for another.

9. **An existing USER of a tenant invites an account into it**, and
   accepting the invitation is what creates that tenant's user. (A tenant has
   users; "member" stays ADR-0041's word for a user admitted to one
   WORKSPACE, and workspace membership does not by itself confer the right to
   invite. Which users may invite is governance, as fork 2 said.) Not the keeper's operator:
   authority comes from owning the resource (ADR-0035 decision 4), and an
   operator who could add people to any tenant would be an issuer of identity
   in all of them. The first user comes with the tenant's creation.

10. **An account carries a display name for ITS OWN picker** — "work",
    "private" — shown where a person chooses a passkey, and never shown to a
    tenant. Decision 4 says nothing joins two accounts; without a name the
    person is left telling two identical-looking entries apart from memory,
    which is a usability answer rather than a change to the model. A tenant
    still reads only the user's name (decision 1).

## Decisions taken, second round (owner, 2026-09-23)

Decision 7 met the code. A credential is registered against the hostname it
was created at, and under decision 7 every tenant has its own hostname — so
an account's passkey would work in exactly one tenant, and a person with
three tenants would enrol three times. That is the cost decision 2 exists to
remove, so the first round could not stand as written.

11. **An account's passkey is registered against the keeper's parent
    domain** — `example.com`, not `acme.example.com`. WebAuthn lets a
    credential name a registrable suffix of the origin it is created at, and
    every tenant subdomain then offers the same credential. What this does
    NOT weaken: which tenant a sign-in is FOR is still the request's host
    (decision 7), checked against the assertion's origin, so the browser
    still refuses to carry one tenant's session to another. Chosen over
    keeping the per-hostname registration, which is stronger isolation and
    leaves an account holding nothing but a picker name.

12. **Sign-in happens at the tenant's own subdomain.** The session belongs to
    that host alone, and "choosing a tenant" is opening its address. Chosen
    over a central sign-in page at the parent domain that hands a session
    across to the tenant: that handoff is a token crossing origins, which is
    a new way for a session to leak, and it buys only a list of one's own
    tenants.

13. **The account -> user link is kept inside each tenant.** A tenant's user
    row names the account it belongs to; the keeper-wide table holds accounts
    and their credentials and nothing about tenants. So nothing keeper-wide
    can answer "which tenants is this person in" — not a tenant's admin, and
    not the operator reading one table. Chosen over a keeper-wide link table,
    which is what a tenant list after sign-in would need and decision 12
    removed the need for. The per-tenant passkey pins decision 8 moved stay:
    they record that THIS tenant accepts a credential, which is the link's
    authentication half.

14. **A person switches accounts from a menu, the way Google's corner menu
    does**, without signing out. Each tenant's host holds sessions for
    several accounts at once, and the menu lists the accounts signed in on
    this host, plus the tenants this BROWSER remembers having opened.
    Switching to an account already signed in on the host takes no passkey
    gesture; opening a remembered tenant not yet signed in takes one, and
    needs no new enrolment because of decision 11. Chosen over Google's own
    shape — one accounts domain holding every session and handing them to
    each tenant — because that handoff is exactly what decision 12 refused.
    The tenant list lives in the browser, not the keeper, so decision 13
    holds: nothing keeper-wide learns which tenants a person uses. Per
    decision 6, a self-host keeper with one account shows no menu.

## Decisions taken, third round (owner, 2026-09-23)

15. **How an account is authenticated is a seam, not a decision this ADR
    makes.** The owner's framing: for a self-host keeper, being able to plug
    in one's own authentication is itself a reason to choose it, so the
    model must not be bound to the passkey.

    An account is therefore identified by a pair — which authenticator
    vouched, and the subject it vouched for — and an account may hold
    several such pairs (a passkey and an organisation's identity provider,
    say). The built-in passkey is one authenticator; an external identity
    provider, a header set by a reverse proxy the operator trusts, or a
    directory are others, supplied by whoever deploys the keeper. The
    server-mode bearer-token seam already takes an external validator that
    returns an issuer and a subject, and becomes one authenticator rather
    than a parallel path — but not as it stands: it deliberately surfaces
    only the subject and scopes to what it authorizes, so resolving to an
    account means either doing that resolution inside the strategy or
    carrying the authenticator's identity forward without exposing raw
    issuer metadata to unrelated surfaces.

    What stays fixed whatever the authenticator: an account is not a user
    (decision 1), authority reaches a resource only through a user
    (ADR-0043), and nothing joins two accounts (decision 4) — an
    authenticator that reports the same subject for two people is the
    deployment's error, not a merge this model performs. Decisions 11 and
    14's no-gesture switch are about the passkey authenticator and bind
    only it.

    Scope, and why: this is the part of the ADR worth building BEFORE a
    many-tenant keeper exists, because it pays at one tenant — a self-host
    operator can bring their own sign-in — and because splitting today's
    profile into account plus user is the migration a later SaaS would
    otherwise have to run over real data. Per-request tenant binding
    (decision 7) and the switcher (decision 14) wait for a keeper with more
    than one tenant.

## Consequences

- **The subdomain decision reaches further than the first increment.**
  Decision 8's per-tenant grants and pins are built. Host-derived tenant
  selection, host-scoped sessions, CORS following the host, and wildcard
  DNS and certificates wait, per decision 15, for a keeper that can hold
  more than one tenant.
- **Easier:** a tenant's member list cannot leak that a person exists
  elsewhere, because it is a list of users and a user belongs to one tenant.
  Attribution stays stable when an account is deleted, since a user is not the
  credential.
- **Harder:** two objects where there was one, and the join has to be right or
  a sign-in resolves to the wrong tenant's user. The keeper-wide account table
  is the one thing the tenant handle deliberately does not scope, so its every
  query is a place isolation can be lost.
- **A migration when it lands:** the credential rows have to split, with each
  existing profile becoming one account plus one user. In a self-host that is
  a one-to-one rewrite; there is no SaaS data yet.
- **An account cannot be deleted by one query.** Decision 13 means its users
  are found by asking each tenant, so deleting an account is a sweep over
  tenants — acceptable because it is rare, and the price of the keeper-wide
  table knowing nothing about tenants.
- **Cost of recording it now:** the tenant increment classified
  `memberProfiles` and `profileCredentials` as tenant-scoped, which is the
  reading this ADR makes permanent for the user half and provisional for the
  credential half.

## Alternatives considered

- **A profile is global, joined to tenants by memberships.** One object, no
  migration, and it breaks the constraint: a tenant would read a display name
  the person set for another tenant, and an admin listing members would see an
  identity that is not theirs.
- **A profile is tenant-scoped and there is no account.** What ships today,
  extended. Each tenant's profile then owns its authentication directly: a
  passkey is enrolled per tenant, so a keeper with many tenants asks the same
  person to enrol repeatedly, and an external authenticator has to be wired
  to profiles one tenant at a time. It also leaves a single-tenant self-host
  no place to plug its own sign-in in without coupling it to the user a
  workspace sees — the reason decision 15 builds the account first.
- **An account IS the user, with per-tenant presentation fields.** Removes
  the account -> user link, and with it makes the identity a tenant sees
  keeper-wide: either every tenant reads one shared identity — the
  constraint the owner set — or a tenant-local user is recreated under
  another name. It also stops one account resolving to separately governed
  users in different tenants, which is decision 3.
