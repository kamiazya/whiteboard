# ADR-0047: A server-mode keeper serves the web app it was built with, and tells its operator when it is behind

**Status:** Draft. The owner took the decisions below on 2026-09-24, after a
comparison of bundling, proxying and a signed update channel. Decision 3 moved
to [ADR-0048](0048-update-notice.md) on 2026-09-25, which decides how releases
mark a vulnerability and defers the work until the first release past 0.0.x.

## Context

[ADR-0045](0045-account-and-user.md) decision 12 puts sign-in at the tenant's
own host: the session is a cookie that host alone receives. So the page that
uses the session has to come from the keeper's origin.

Today it does not come from anywhere. A server-mode keeper answers a browser
with a placeholder, and the web app has no server-mode support. The local
daemon redirects every page except the pairing page to the official hosted
app. That app runs on its own origin and reaches the daemon across origins,
so it cannot carry the keeper's session.

The question is therefore not WHERE the page is served (the keeper's origin),
but where its CODE comes from and how it is kept up to date. The owner's
concern (2026-09-24):

> 懸念しているのはアップデートされていないセルフホスト版で脆弱性が放置されることです。

In short: a self-hosted keeper nobody updates keeps its vulnerabilities.

**Where a stale keeper's vulnerabilities live.** In two places, and how the
web app is delivered reaches only one of them:

- **The web app** — what runs in the browser: rendering, sanitisation, its
  dependencies. Fetching a newer copy fixes these.
- **The keeper** — authentication, authorization, input validation, the
  runtime and its dependencies. Only a new image fixes these.
  [ADR-0046](0046-external-sign-in.md)'s first slices closed exactly such a
  hole (a valid bearer reached every workspace), and no delivery method for
  the web app would have closed it on a stale keeper.

**What self-hosted products do.** GitLab, Nextcloud, Vaultwarden and
Mattermost all ship their web app with the server and meet staleness with
notice to the operator. GitLab's version check marks an instance up to date,
behind, or vulnerable. Nextcloud verifies a signature on anything it loads
from outside the release. None of them serves its official web app through a
proxy.

## Decision

1. **The keeper serves the web app built into its own image.** The image
   carries the web build of the same release, and the keeper serves it from
   its own origin. The web app and the keeper it talks to are therefore
   always the same version, so no compatibility contract between them is
   needed yet. A keeper with no network access works from its first start.

2. **The keeper does not proxy the official hosted app.** A caching proxy
   would deliver web fixes quickly. The price is that the official hosting
   becomes one point every self-host depends on, and one point an attacker
   can use against all of them. Its code would run on each keeper's origin
   with the session cookie in reach. It would also leave the keeper's own
   vulnerabilities in place, and it keeps the web app and the keeper
   permanently on different versions.

3. **The keeper tells its operator when it is behind, and does so by
   default** — now [ADR-0048](0048-update-notice.md), which carries this
   decision forward with the one it was missing: how a release says which
   versions it leaves vulnerable. The number stays so that references to
   decision 4 still hold.

4. **A signed update channel for the web app is recorded as a later option,
   not built.** On top of decision 1, a keeper could fetch a newer web build
   from the project, verify it against a key fixed in the image, and serve it
   instead of the bundled one, falling back to the bundled build on any
   failure. This would deliver web-side fixes without an image update, and
   without decision 2's single point of attack: code the key has not signed
   is never served.

   It is not built now because it needs three things that do not exist:
   - a compatibility contract between web builds and keeper versions, since
     the two would differ;
   - custody and revocation for the signing key;
   - a release process that signs and publishes web builds.

   Adopting it is a new decision that names how each of these is met.

## Consequences

- **The server image grows by the web build**, and the image build has to
  produce it. The placeholder page goes away.
- **The web app gains a server-mode path.** It signs in through the keeper's
  providers, holds the session cookie, and reaches the keeper's API on its own
  origin. The daemon's live-socket transport does not exist in server mode, so
  the web app uses the stream-based one there.
- **Web-side fixes reach a self-host only when its operator updates.**
  ADR-0048 is what shortens that interval. Decision 4 is how to remove it
  later, if it proves too long.
- **The release process has to say which releases fix vulnerabilities**, in a
  form the keeper can read. ADR-0048 decides that form: a published security
  advisory.
- **The keeper makes an outbound request by default.** An air-gapped or
  privacy-sensitive deployment turns it off. The self-hosting guide says so
  where it describes the setting.

## Alternatives considered

- **Proxy the official hosted app, with a cache** — decision 2.
- **Serve the web app from the official hosted origin and reach the keeper
  across origins.** The session cookie cannot be used there, so the browser
  would have to hold a token of its own. That contradicts ADR-0045 decision
  12, and it makes every self-host depend on the official hosting to be
  usable at all.
- **Bundle, with no notice.** This is what the placeholder era effectively
  was, and it is the stale-keeper failure the owner named.
- **Bundle, with the check off by default.** The deployments that most need
  the notice are the ones whose operators never turn it on.
