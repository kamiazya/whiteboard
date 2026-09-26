# ADR-0049: People are managed at two levels — a tenant's administrators and a workspace's owners

**Status:** Accepted, in effect since 2026-09-26. The owner took the
decisions below on 2026-09-26, after a survey of how ten self-hosted products
manage people.

- Decisions 1 to 4 are built for server mode, by increment. That covers
  - workspace roles, with the last owner kept;
  - owners managing their workspace's people and inviting into it;
  - a configured administrator list, re-checked at every sign-in, beside a
    command to appoint one;
  - administrators deactivating, reactivating and appointing, with the
    invitation into the tenant alone;
  - the web app's people screens.
- Decision 5 is built as far as it does not depend on how a person is
  identified. The local daemon serves the same people API and the same list.
  The machine's owner (a credential carrying the daemon's administrative
  scope) manages every workspace there, so no workspace there has a last
  owner to keep. Adding a person there is still choosing a pinned passkey.
  How the local daemon identifies a person is
  [ADR-0050](0050-local-daemon-trust.md)'s to change.
- Decision 6 builds nothing.

## Context

A server-mode keeper can sign people in ([ADR-0046](0046-external-sign-in.md))
and keeps every workspace members-only from the start. But once someone is
signed in, nobody can manage anyone from inside the product:

- **No roles.** Nothing distinguishes an administrator from anyone else.
- **Invitations can be redeemed but not created.** ADR-0046 decision 6
  shipped the redeeming half only.
- **Only command-line management.** The operator can add a user and grant a
  membership from the machine that holds the data directory. There is no
  list of users or members, and no way to remove anyone.

The local daemon has the opposite problem. It has a members screen and API
([ADR-0041](0041-profile-and-authority.md)): a member is a person proven by a
passkey, and removing one ends their sessions and withholds the replica key
([ADR-0042](0042-offline-revocation.md)). But a local daemon listens only on
its own machine, so it usually has one person, and the screen has little to
manage. The machinery sits where it is least needed and is missing where it
is needed.

Three earlier decisions constrain the answer:

- **Authority comes from owning a resource** (ADR-0041, after ADR-0035
  decision 4). A keeper may cut a person off from what it keeps. It may not
  become an issuer of who a person is.
- **An existing user of a tenant invites an account into it**
  ([ADR-0045](0045-account-and-user.md) decision 9). The operator does not add
  people to tenants on their own authority. Which users may invite was left
  as governance.
- **The keeper may run where there is no command line.** A worker-hosted
  keeper (Cloudflare) is in view, so nothing may depend on a shell being
  available.

### What established products do

Surveyed: GitLab, Gitea, Forgejo, Mattermost, Outline, Nextcloud, Grafana,
Immich, Vaultwarden, Discourse, Plane.

- **Two tiers once there are several workspaces.** An instance or tenant
  administrator, and a per-workspace, team or organisation owner. Examples:
  GitLab Administrator vs group Owner, Mattermost System Admin vs Team Admin,
  Grafana Server Admin vs Org Admin, Plane instance admin vs workspace admin.
  A single flat tier goes with products that are effectively one workspace
  (Immich, Outline).
- **The first administrator.** Most make the first person to register the
  administrator. Its known failure is a race: whoever registers first on a
  freshly exposed instance takes it. Gitea offers `DISABLE_REGISTRATION` and
  Immich `IMMICH_SKIP_ADMIN_REGISTRATION` for exactly that. Others seed a
  known account (GitLab, Grafana) or a shared token (Vaultwarden). The token
  is flagged as a single secret with no person behind it.
- **Invitations are scoped to a workspace or team, short-lived, and
  preferably single-use** (Plane, GitLab, Mattermost, Discourse). A reusable
  link without a cap is how an open door gets made by accident.
- **Deactivating and deleting are different acts.** Mattermost ends every
  session at once on deactivation; GitLab lets a deactivated user reactivate
  themselves by signing in. Products that blur the two surprise operators.
- **Administrator rights from an identity provider's claim** are offered by
  GitLab, Mattermost, Grafana and Discourse. Each re-checks at every sign-in,
  and Discourse warns to do it only with a provider you fully control.
- **Step-up re-authentication for administrative actions** is rare. GitLab's
  Admin Mode is the one clear example.

## Decision

1. **Two levels, each over what it owns.**
   - **A tenant's administrators** manage the tenant's people: create
     invitations to the tenant, deactivate and reactivate users, and appoint
     or remove other administrators.
   - **A workspace's owners** manage that workspace's people: add and remove
     its members, create invitations to it, and make another member an owner.
     The person who creates a workspace is its first owner.

   An administrator is not thereby an owner of every workspace. They cannot
   read a workspace they are not a member of, or change its members. That is
   decision 1 of ADR-0041 applied to people: authority reaches the resource a
   party owns, and a tenant does not own its members' workspaces. What an
   administrator can do to a person is deactivate them, which takes them out
   of every workspace at once (decision 4).

2. **The first administrator is named by the operator, either from the
   command line or in configuration, never by being first.**
   - **Command line:** a command on the machine that holds the data. It is
     the same trust that adding a user and granting a membership already
     rest on.
   - **Configuration:** a list naming people by provider and subject, for a
     keeper with no shell, such as a worker. A person the list names is an
     administrator while the list names them. Because it is checked at every
     sign-in, removing a name removes the role at that person's next
     request.

   An email address is not accepted as a name. A subject cannot be claimed
   by registering first. Administrators appointed through the product are
   kept in the tenant's records, separately from the configured list, so
   neither overwrites the other.

3. **An invitation invites a person into a workspace.** An owner creates it.
   Accepting it makes the person a user of the tenant, if they are not one
   already, and a member of that workspace, in one step. It is single-use
   and expires, as ADR-0046 decision 6 already requires. An administrator may
   also create an invitation that names no workspace, which makes a user and
   nothing more.

   ADR-0046 decision 4 is unchanged: creating an account is invitation-only
   by default. Any other path still goes through the admission function.

4. **Deactivation is the removal an administrator makes.**
   - It ends the person's sessions at once, as removing a member already
     does.
   - It keeps their data and memberships, so reactivating restores exactly
     what they had.
   - Only an administrator can reactivate. Signing in again does not.

   Deleting a person, and what becomes of what they wrote, is not decided
   here. *(Decided by [ADR-0051](0051-deleting-a-person.md).)*

5. **One members surface for both keepers.** The local daemon uses the same
   members screen and API as server mode. The keeper decides only how a
   person is identified: a pinned passkey on the local daemon, an
   authenticator binding on server mode. The passkey check and the withheld
   replica key (ADR-0042) stay as they are. On a local daemon, the person who
   owns the machine is its administrator and every workspace's owner.

6. **No step-up re-authentication for administrative actions, for now.** An
   administrator's session is an ordinary session. This is recorded as a
   decision, not an omission. The trigger for revisiting it is an
   administrative action that cannot be undone, and deletion (decision 4) is
   the first candidate. *(Revisited by [ADR-0051](0051-deleting-a-person.md),
   which requires a recent sign-in for every tenant administrator's action.)*

## Consequences

- **Membership gains a role.** A membership is `owner` or `member`. A
  workspace is never left without an owner by the product: removing or
  demoting its last owner is refused. A workspace whose owners are all
  deactivated is recovered with the operator's existing command.
- **Administrator is a tenant-level role**, kept outside the synced workspace
  record, for the reason memberships are (the vocabulary's Membership row: a
  merge must not resurrect a role that was removed).
- **The server-mode web app gains a people screen**, and the local daemon's
  settings card becomes that screen.
- **A configured administrator list is a credential in configuration.** A
  wrong subject there is a wrong administrator. The self-host guide says so
  where it describes the setting.
- **An identity-provider claim does not grant administrator rights.** A
  provider's group claim can still admit a person (ADR-0046 decision 8). It
  cannot make them an administrator. That can be added later as its own
  decision, re-checked at every sign-in.

## Alternatives considered

- **Administrators only, no owners.** Simpler, and the shape of small
  single-workspace products. It means a person who creates a workspace
  cannot add anyone to it without an administrator, and it gives
  administrators every workspace, which decision 1 refuses.
- **Owners only, no administrators.** No new role. But removing a person who
  has left the organisation means finding and editing every workspace they
  were in, or reaching for the command line.
- **The first person to sign in becomes administrator.** The most common
  default, and a race on a freshly exposed keeper. The invitation-only
  default makes it worse here, not better: the first person admitted is
  whoever reaches the sign-in page first.
- **Invitations to the tenant, with workspace access granted separately.**
  Cleaner separation of duties, but two steps for the case that matters. The
  person inviting is almost always the workspace's owner, who then has to
  find an administrator.
- **Retire the local daemon's members screen.** A single person seldom needs
  it. But it carries ADR-0042's replica-key withholding, and a second
  implementation for server mode would drift from the first.
