# ADR-0051: Deleting a person, and re-authenticating for administration

**Status:** Proposed. The owner took the decisions below on 2026-09-26, after a
survey of how ten products delete people and guard administrative actions.
Nothing is built. It decides the two things
[ADR-0049](0049-managing-people.md) left open: deleting a person (its decision
4) and step-up re-authentication (its decision 6), whose named trigger was
deletion.

## Context

ADR-0049 gave a server-mode keeper deactivation. It ends a person's sessions
at once, keeps their data and memberships, and only an administrator reverses
it. It deliberately did not decide deletion. It also ruled out step-up
re-authentication "for now": an administrator's session was an ordinary
session, until an administrative action existed that could not be undone.
Deletion is that action.

What established products do:

- **Deactivation is the everyday removal, and deletion is a separate, heavier
  step.** Zulip and Mattermost both recommend deactivating over deleting,
  because deactivation is reversible and leaves history alone.
- **Authored content is kept under a placeholder rather than deleted.**
  - GitLab reassigns a deleted person's contributions to a "Ghost" user.
  - Mattermost shows "Deleted User", and Outline shows "Unknown".
  - Discourse anonymises the account in place.
  - The product that deletes the messages too (Rocket.Chat) breaks the
    conversations other people are still in.
- **A sole owner blocks deletion.** GitLab refuses to delete the sole owner of
  a group until ownership is transferred. Nextcloud expects files to be
  transferred first.
- **Re-authentication needs an answer for sign-in that lives elsewhere.**
  GitHub's sudo mode could not prompt anyone who signed in through an
  external identity provider, and was silently skipped for them. GitHub's
  2026 fix sends the person back to the provider for a fresh sign-in. OpenID
  Connect already has the primitive:
  - `prompt=login` forces an interactive sign-in;
  - `max_age` bounds how old the authentication may be;
  - the ID token's `auth_time` says when it happened.

Four facts about this codebase constrain the answer:

- **Who authored a comment or a proposal is not a user id.** Where it is
  recorded at all, it is a free-form actor string inside the workspace's
  synced record. The web app records none. An operation cannot rewrite the
  history under it, and every replica holds a copy of that history.
- **Identity tables have no foreign keys**, by house style. Nothing cascades,
  so deletion sweeps each table itself.
- **An account and its authenticator bindings belong to the keeper, and a
  user belongs to one tenant.** One account can be a user in several tenants.
- **Signing in again after a user row is gone reaches the newcomer path.**
  With no user row, the keeper cannot tell a deleted person from someone it
  has never seen.

## Decision

1. **Only a deactivated person can be deleted, and deletion is immediate and
   final.** Deactivation is the reversible step and serves as the grace
   period, so there is no separate soft-delete window or purge job. Deleting
   is an administrator's action. Nobody deletes themselves.

2. **What they wrote stays; who they were goes.**
   - The user row goes, and with it their display name and everything else
     identifying them to this keeper.
   - Their memberships, their administrator appointment, their pending
     invitations and any remaining sign-in sessions are removed.
   - Their account and authenticator bindings are removed when no other
     tenant's user holds them.
   - A record that referred to them by id (who invited someone, who appointed
     an administrator) keeps the id, and the product shows it as a deleted
     person rather than failing to resolve it.
   - Comments, proposals and document content they wrote are kept as they
     are.
   - Actor strings already written into a workspace's history are not
     rewritten. They cannot be removed from history or from the replicas
     that hold it, and the product does not pretend otherwise.

3. **A person who is the only owner of a workspace cannot be deleted.** The
   refusal names those workspaces. An owner of each must be appointed first,
   by the same means as today: an owner making another member an owner, or
   the operator's `grant-member`.

   A deactivated owner still counts as an owner under ADR-0049, which is why
   this check is needed at all. It is the same rule that keeps a workspace's
   last owner, applied before the rows go.

4. **The keeper forgets them.** Nothing records that the person existed. If
   the same person signs in again, they are a newcomer, and the admission
   rules decide as for anyone else. Under the default (invitation only) they
   are refused. If admitted, they are a new user with no memberships and no
   role.

   This is consistent with ADR-0046 decision 5, "not revived by signing in
   again": nothing of the deleted user returns. What this decision gives up
   is barring them: the keeper keeps no identifier to bar them with.

5. **Every tenant administrator's action requires a recent sign-in at the
   identity provider.** The actions covered are:
   - deactivating, reactivating and deleting a person;
   - appointing and dismissing an administrator;
   - creating an invitation to the tenant.

   It works like this:
   - An action is accepted when the session's authentication at the
     provider, the ID token's `auth_time`, is at most **15 minutes** old.
   - Otherwise the web app sends the person back to the provider, with
     `prompt=login` and `max_age`. Returning refreshes the window.
   - A provider that does not return `auth_time` cannot be used for
     administration.

   Two paths are closed or left as they are:
   - **Bearer tokens cannot perform these actions.** A bearer has no
     browser to send back to the provider.
   - **The operator's command line needs no re-authentication.** Its trust
     is already the machine that holds the data.

   A workspace owner's actions are not covered: changing roles, removing
   members and inviting into a workspace. They are reversible, and they
   reach one workspace rather than the whole tenant.

6. **The local daemon does not get deletion now.** A person there is
   identified by pinned passkeys, and
   [ADR-0050](0050-local-daemon-trust.md) replaces that. Removing someone from
   a workspace there stays what it is today.

## Consequences

- **Deletion is two actions, a while apart.** Anyone wanting a person gone
  "now" deactivates them, which takes effect at once. Deletion follows when
  they are sure.
- **A keeper keeps no memory of whom it deleted.** An administrator who wants
  someone kept out deactivates them rather than deleting them. The admin
  guide has to say so, because it reads backwards.
- **Administration costs a sign-in every 15 minutes of activity at most.**
  It uses the provider's own sign-in, so it gets whatever second factor the
  provider enforces. The keeper gets no factor of its own.
- **Automation of tenant administration moves to the operator's command
  line.** A bearer-driven script can no longer deactivate or appoint.
- **A provider must return `auth_time`.** OpenID Connect requires it when
  `max_age` is requested, and a provider that omits it anyway is named in the
  refusal rather than silently allowed.
- **Deleting a person does not remove their words from history.** For a
  jurisdiction where that matters, what a keeper can offer is removing the
  identifying fields it holds, which decision 2 does. Actor strings written
  by agents into a workspace's history are outside it.
- **A connection that is already open survives deactivation today.** WebSocket
  and SSE membership is checked when they open. Deletion inherits that from
  deactivation, and closing them is a separate fix.

## Alternatives considered

- **Delete their content too.** This is the only way the words are gone as
  well as the name. But other people's comments reply to them and other
  people's proposals build on them, so deleting damages everyone else's
  record of the work.
- **Rewrite actor strings in the live record.** It makes the latest state
  read "Deleted user", and leaves the original in history and in every
  replica. That looks like erasure and is not.
- **A grace period with a scheduled purge.** This is GitLab's shape. Here it
  would duplicate deactivation, which already is a reversible hold, and it
  would add background work that only exists to wait.
- **Transfer a sole owner's workspaces automatically.** It avoids the
  refusal. But "to whom" is a choice someone should make, and the most
  senior remaining member is a guess.
- **Keep a record that bars the deleted person from returning.** It stops
  them coming back through an invitation or open admission. But the keeper
  would then hold their identifier indefinitely, which is the thing deletion
  was asked to remove, and deactivation already does the barring.
- **Re-authenticate for deletion only.** The smallest change. But an
  administrator session taken over could still appoint a second
  administrator or deactivate everyone, and ADR-0049's own trigger, an action
  that cannot be undone, is arguably met by appointing an administrator who
  then acts.
- **A keeper-local second factor for administration.** It would work with
  any provider. But it asks every administrator to enrol a factor the
  provider already manages, and it is a second authentication system to
  keep correct.
