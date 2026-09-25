# ADR-0048: A keeper tells its operator when it is behind, from the project's published security advisories

**Status:** Proposed — decided by the owner on 2026-09-25 and deferred. It
takes effect when the project prepares its first release past 0.0.x: while
every release is 0.0.x, there is no operator besides the owner to tell.
Nothing is built.

## Context

[ADR-0047](0047-server-mode-web-app.md) has a server-mode keeper serve the
web app bundled in its own image. A self-host therefore runs whatever version
its operator last installed. Fixes, security fixes included, reach it only
when the operator updates. Neither half of the stack updates itself.

ADR-0047 originally carried a third decision: the keeper notices when it is
behind and says so. This ADR takes it over, for two reasons.

- **It needs a decision ADR-0047 did not make.** The keeper can only say
  "vulnerable, update now" if releases say which versions are affected, in a
  form the keeper can read. Without that, it can only say "behind".
- **Its timing is different.** ADR-0047's first two decisions are built. This
  one is not needed until someone other than the owner operates a keeper, and
  that is not yet the case: every release so far is 0.0.x.

The project's releases today are tagged by release-please, one tag per
package (the keeper is `@kamiazya/whiteboard-mcp`, tagged `mcp-server-v*`).
Vulnerabilities are reported privately through GitHub's security advisories,
as the security policy asks. None has been published.

## Decision

1. **A release that fixes a vulnerability is marked by a published GitHub
   Security Advisory.** The advisory names the keeper's npm package, the
   affected version range and the patched version. Publishing it is a step
   in shipping the fix.

   The range is structured data that other tools already read: `npm audit`
   and Dependabot report the same advisory to anyone depending on the
   package. The project defines no format of its own.

2. **The keeper checks, on a schedule and by default, whether it is behind.**
   It reads two public answers:
   - the newest release of its own package (newest non-draft, non-prerelease
     `mcp-server-v*` tag);
   - the published advisories whose range covers its own version.

   It places itself in one of three states: up to date, update available, or
   vulnerable — update now. Both answers are parsed against a schema, and one
   that does not parse leaves the previous state standing rather than
   reading as "up to date".

3. **Every instance checks for itself.** Each reports its OWN version, and
   during a rolling update two instances run different ones. So the check is
   declared as work every instance runs, not work for a leader. It costs one
   small request a day each, far below the provider's limit for requests
   without credentials.

4. **The state appears where the operator already looks.** Those places are
   the keeper's status and doctor commands, and the keeper's log when an
   instance first finds itself vulnerable. The web app shows it to a
   signed-in administrator once such a role exists. There is none today, so
   the command-line half comes first.

5. **The request carries nothing about the deployment, and an operator can
   turn the check off.** It is on by default because the failure it exists
   for — a keeper nobody knows is vulnerable — is exactly the one an
   off-by-default setting leaves in place. The self-hosting guide says so
   where it describes the setting.

6. **It takes effect with the first release past 0.0.x.** That release ships
   the check, and from it on, decision 1 is part of the release process.
   Before it, nothing is built. A vulnerability found meanwhile is handled as
   the security policy already says.

## Consequences

- **The release process gains one step**, and only for security fixes:
  publish the advisory with its range. A fix shipped without one leaves every
  keeper saying "update available" at most, never "vulnerable".
- **A keeper makes an outbound request by default.** An air-gapped or
  privacy-sensitive deployment turns it off.
- **The state only helps keepers that already have the check.** A version
  released before this ADR takes effect never reports anything. That is part
  of why the check has to ship in the first release that invites other
  operators, not later.
- **Open when the work starts: where the status command reads the state
  from.** That command runs beside the data directory rather than inside the
  server. Several instances sharing one volume would overwrite a single result
  file. Two ways out, each with a cost:
  - keep one result per instance, so the command reports several;
  - have the command run the check itself when invoked, at the cost of a
    request per invocation.

## Alternatives considered

- **A manifest attached to each release, listing affected versions.** It
  says the same thing in a format of the project's own. The release workflow
  would have to produce it, and nothing but the keeper would read it.
- **A convention in the release notes** (a security section fed by commits
  typed as security fixes). It needs no new step. But it says only "this
  release fixed something", not which versions are affected, and the keeper
  would have to parse prose.
- **Build the check now.** Nobody but the owner runs a keeper, and the owner
  follows the repository. The check would run for no audience until the
  first release past 0.0.x, and the release step in decision 1 would be a
  ritual with nothing reading it.
