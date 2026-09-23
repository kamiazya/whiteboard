# ADR-0046: External sign-in is an authenticator an operator configures, admitted by rules checked at every sign-in

**Status:** Draft — the owner took the decisions below on 2026-09-23, after a
survey of how established self-hosted products do this. Nothing here is built.
It builds on [ADR-0045](0045-account-and-user.md), whose decision 15 made
authentication a seam and left what plugs into it open. This ADR fills that in.

## Context

ADR-0045 split the login identity (an ACCOUNT, keeper-wide) from who that
account is inside a tenant (a USER). It also keyed an account on bindings of
`(authenticator, subject)`, with the passkey as the built-in authenticator.
What an operator's OWN sign-in looks like was deliberately left open. The owner
set two requirements (2026-09-23):

> どの外部IdPを許可するか、例えばGoogleだったときにどのドメインのアドレスの
> アカウント発行を許容するかなどは拡張できるようにしてください。

In short: which external identity providers are allowed, and which accounts
each may create (for Google, which email domains), must both be extensible.

**Where the keeper stands today.** A server-mode keeper validates bearer access
tokens from one configured issuer and nothing else:

- It has no sign-in flow, no session cookie, and no sign-in screen. The
  self-hosting guide says so.
- The validated issuer and subject are dropped before any handler can see
  them.
- Server mode has no workspace membership gate at all, so a valid token
  reaches every workspace.

**What established products converge on.** Surveyed: Outline, Grafana,
Gitea/Forgejo, GitLab, Mattermost, Nextcloud, HedgeDoc, Immich, Vaultwarden,
Plane, Sentry, Discourse, oauth2-proxy, Pomerium and Tailscale Serve. Sources
are at the end.

- **Generic OIDC with discovery is the connector.** Vendor presets (Google,
  GitHub, Microsoft) are sugar over it, and HedgeDoc v2 and Nextcloud allow
  several named providers at once.
- **"May this provider sign someone in" and "may signing in CREATE an
  account" are two settings, not one.** Examples: Immich's Auto Register,
  GitLab's `allow_single_sign_on` and `block_auto_created_users`, Gitea's
  `ENABLE_AUTO_REGISTRATION`, Nextcloud's `auto_provision`. The cautious
  products make pre-created accounts the default. Immich's documentation says
  to leave auto-registration off.
- **Admission is re-checked at every sign-in, not only the first.** Grafana's
  `allowed_domains`, Mattermost's `RestrictCreationToDomains`, and Gitea's
  required claims all work this way. A person's domain or group can change
  between sign-ins.
- **The stable identity key is (provider, external subject), never the email
  address.** GitLab's `extern_uid` and Nextcloud's hash of provider and
  subject both follow this. It is the shape ADR-0045 already chose.
- **A forwarded identity header is only trusted from a restricted network
  position.** Grafana `auth.proxy` has an IP whitelist. Tailscale Serve
  documents binding to localhost. Pomerium signs the identity it forwards.

**The failures in this area share a small number of shapes:**

- **A switch that closes one creation path and not another.** Vaultwarden had
  to add `SSO_SIGNUPS_ALLOWED` because "signups disabled" did not cover SSO.
  Mattermost's domain restriction was reported not to apply to Google OAuth.
- **Linking or creating on an email the provider has not verified.** GitLab
  documents its email-match `auto_link_user` as less secure than the default.
  Discourse warns that unverified emails leave a site "extremely vulnerable".
- **Trusting a domain claim without the provider's own verification.** In the
  July 2024 Google Workspace incident, accounts were created for domains that
  were never verified and then used to sign in elsewhere with Google.
- **An external sign-in path that skips a check the primary path makes.** Gitea
  has published advisories where OAuth sign-in skipped a second factor or
  revived a deactivated account.

## Decision

1. **The keeper is an OIDC relying party.** A person signs in at the tenant's
   own host (ADR-0045 decision 12). The keeper runs the authorization code
   flow with PKCE against the provider, and issues a session scoped to that
   host.

   The bearer-token path that MCP clients use stays. It resolves through the
   same authenticator to the same account, rather than being a parallel
   notion of who is calling.

2. **A header set by a trusted reverse proxy is a second authenticator, added
   after the first.** The owner chose both; OIDC comes first. It is only ever
   accepted from a declared trusted position (an address allowlist, or a
   listener bound to loopback), and a signed assertion is preferred to a bare
   header. Without that restriction it is not offered at all.

3. **Providers and their admission rules live in the configuration file.**
   Several named providers may be declared at once, each with its own rules.
   The file is validated by one schema.

   Client secrets stay in the file or the environment, never in the database.
   A change takes a restart.

   Chosen over an administration screen backed by the database, which buys live
   edits and per-tenant variation at the cost of secrets in the database and a
   screen to build. That can come later as an overlay, without changing the
   file's meaning.

4. **Creating an account is invitation-only by default. Each provider may
   opt in to creating one on its own.** With no opt-in, a person the provider
   authenticates but nobody invited is refused, whatever their domain. With the
   opt-in, a person who satisfies that provider's rules gets an account and
   this tenant's user on first sign-in.

   Whichever creates it, the provider must assert the email is verified
   whenever an email or its domain takes part in a rule.

5. **Admission rules are checked at EVERY sign-in and on every path that can
   create an account.** That covers OIDC sign-in, the bearer path, and a later
   header authenticator. It is one function every path calls, not a copy per
   path.

   A person who no longer satisfies a provider's rules is refused even though
   their account exists. A membership or user a keeper removed is not revived
   by signing in again.

6. **An invitation reaches a person in two ways, and the first is the
   default:**
   - a **one-time, expiring invitation link**. Whoever opens it signs in with
     any authenticator the tenant accepts, the passkey included, and that
     account becomes the invited user. No email is trusted.
   - an **invitation to an email address**, enabled per provider. It is
     honoured only when that provider asserts the same address as verified,
     and it never applies to a passkey, which carries no email.

   Either way the invitation creates a USER for an ACCOUNT (ADR-0045 decision
   9). It never attaches a new binding to an account that already exists.

7. **Nothing links an external identity to an existing account by matching
   email.** That is ADR-0045 decision 4 made concrete. Adding a second
   authenticator to one's own account is a separate, explicit act made while
   signed in with the first.

8. **Rules are declarative, and code may add an authenticator or a rule.**
   The file offers a fixed vocabulary per provider:
   - allowed email domains;
   - Google's hosted-domain claim (`hd`), preferred to the address suffix when
     the provider is Google;
   - required claim values;
   - allowed GitHub organisations.

   There is no expression language. What the vocabulary cannot say is
   supplied in code at distribution time, the same way facet plugins are: an
   authenticator, or an admission rule that receives the verified claims and
   answers admit or refuse.

   The configuration file still names no module to load. Code-loading
   configuration stays refused.

9. **SAML is out of scope.** Every product surveyed that offers it pays for
   XML signing and its endpoints. The providers self-hosters use today speak
   OIDC. It can arrive later as an authenticator in code (decision 8).

## Consequences

- **Server mode gains the membership gate the local daemon has.** Once a
  request has a person behind it, the gate can be enforced; until then a valid
  token reaches every workspace. This is the most important change here.
- **The authentication decision must be carried to the handlers.** Today it is
  discarded after the check. The account behind a request becomes something a
  handler can read, without the provider's raw metadata travelling with it.
- **A second creation path exists, and the danger is exactly that.** Decision
  5 is written as one function because the surveyed failures are all a second
  path that skipped the first path's check.
- **Invitation links are bearer secrets.** They are single-use, expire, and
  are stored hashed. Sharing one is a decision the inviter makes.
- **The web app needs a sign-in screen for server mode.** It has none.

## Alternatives considered

- **Leave sign-in to a reverse proxy only.** The least code in the keeper, but
  an operator must run a second component to sign anyone in, and the keeper
  learns nothing it can admit on. Kept as decision 2's second authenticator
  rather than the only one.
- **Store providers in the database with an admin screen.** Decision 3 says why
  not first.
- **Create accounts automatically whenever a provider's rules pass.** Simplest
  to adopt, but a mis-written domain rule opens the keeper to everyone that
  rule admits, silently. Decision 4 keeps this available per provider, off by
  default.
- **An expression language over claims (Grafana's JMESPath).** Expressive, but
  operators must learn it, and a mis-evaluating expression reads as a working
  one. Decision 8 puts the long tail in code instead, where it is tested.

## Sources

- Outline OIDC: https://docs.getoutline.com/s/hosting/doc/oidc-8CPBm6uC0I
- Grafana generic OAuth and auth proxy:
  https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/generic-oauth/
  and
  https://grafana.com/docs/grafana/latest/setup-grafana/configure-security/configure-authentication/auth-proxy/
- Gitea authentication and security advisories:
  https://docs.gitea.com/administration/authentication/ and
  https://about.gitea.com/security/
- GitLab OmniAuth: https://docs.gitlab.com/integration/omniauth/
- Mattermost OIDC and the domain-restriction report:
  https://docs.mattermost.com/administration-guide/onboard/sso-openidconnect and
  https://github.com/mattermost/mattermost/issues/5339
- Nextcloud user_oidc: https://github.com/nextcloud/user_oidc/blob/main/README.md
- HedgeDoc v2 OIDC: https://docs.hedgedoc.dev/references/config/auth/oidc/
- Immich OAuth: https://docs.immich.app/administration/oauth/
- Vaultwarden SSO signups: https://github.com/dani-garcia/vaultwarden/issues/6651
- Discourse DiscourseConnect:
  https://meta.discourse.org/t/setup-discourseconnect-official-single-sign-on-for-discourse-sso/13045
- oauth2-proxy providers:
  https://oauth2-proxy.github.io/oauth2-proxy/configuration/providers/
- Pomerium authentication: https://www.pomerium.com/docs/capabilities/authentication
- Tailscale Serve identity headers: https://tailscale.com/docs/features/tailscale-serve
- Google Workspace verification incident (2024):
  https://krebsonsecurity.com/2024/07/crooks-bypassed-googles-email-verification-to-create-workspace-accounts-access-3rd-party-services/
