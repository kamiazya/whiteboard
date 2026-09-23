# ADR-0045: An account is who logs in; a user is who a tenant knows

**Status:** Draft — the shape and its open forks were recorded on 2026-09-23
while the conversation was fresh, and the owner answered all of them the same
day (see **Decisions taken** below). A second round, forced by what the
first round's implementation exposed, was answered the same day too
(decisions 11-13). Of all of it only decision 8 is built — the origin-keyed
stores live under their tenant — and
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

2. **An ACCOUNT is the login identity: what a passkey authenticates.** It is
   keeper-wide, belongs to no tenant, and holds credentials. It carries no
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

5. **The credential table moves under the account, and nothing else moves.**
   `profileCredentials` (credential -> profile) becomes credential -> account
   plus account -> user, the second half kept inside each tenant
   (decision 13). That is a change on the authentication side only; the
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
   pairing grant is an origin the user approved, a passkey pin is keyed by
   origin, and a credential's rpId is the origin it was registered at. Under a
   path prefix every tenant shares one origin, so the browser-side boundary
   disappears and only the server's own check is left; under a session, a
   mistake in that check IS the leak. A subdomain makes the browser enforce
   what the server also enforces. It costs DNS and certificate work for each
   tenant, which is an operator's cost rather than a user's.

   Consequence for `authMode`: `'local-daemon'` vs `'server-mode'` is NOT the
   tenant discriminator. It stays what it is — how the daemon authenticates —
   and the tenant comes from the request's host.

8. **The file-backed stores are partitioned per tenant too**: pairing grants
   and passkey pins move under the tenant's directory, beside its blobs. With
   decision 7 this is the same boundary twice over, since an origin now names
   one tenant. Left keeper-wide they would mean "an origin this KEEPER trusts",
   and a grant one tenant gave would answer for another.

9. **An existing member of a tenant invites an account into it**, and the
   invitation is what creates that tenant's user. Not the keeper's operator:
   authority comes from owning the resource (ADR-0035 decision 4), and an
   operator who could add people to any tenant would be an issuer of identity
   in all of them. The first member comes with the tenant's creation.

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

## Consequences

- **The subdomain decision reaches further than this ADR.** Every origin-keyed
  store (grants, pins) gains a tenant, the daemon's CORS and cookie scope
  follow the host, and a deployment needs a wildcard certificate. None of that
  is work this ADR does; it is what decision 7 commits to.
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
  extended. A person then registers a passkey per tenant, and a keeper with
  many tenants asks the same person to enrol repeatedly — acceptable at one
  tenant, which is why it is what ships, and the reason this ADR is a draft
  rather than a rewrite.
- **An account IS the user, with a per-tenant nickname.** Collapses decision 3
  into a field. It reads simpler and loses decision 4: two accounts for one
  person become impossible, so "work and private" cannot be expressed.
