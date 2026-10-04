# Release Publishing Guide

Operator runbook for publishing `@kamiazya/whiteboard-mcp` to npm and GHCR.

---

## Required GitHub Environments

Three protected environments must exist before a release run reaches its publish and deploy jobs:

| Environment | Job | Purpose |
|---|---|---|
| `production-npm` | `publish-mcp` | npm OIDC Trusted Publishing (no token required) |
| `production-docker` | `docker-publish-sign` | GHCR push + cosign keyless signing |
| `production-web` | `deploy-web` | Cloudflare Pages production deploy; holds `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` |

The two publish environments should require at least one reviewer before the job runs.
Without the environment protection, the `release.yml` publish guard is incomplete.
`production-web` carries the Cloudflare secrets, so protect it the same way.
`release-please` and `advance-stable` bind no environment: neither holds a registry or
deploy credential. The PR-preview deploys use a separate `preview-web` environment, which
is not part of a release (see [cloudflare-pages.md](deployment/cloudflare-pages.md)).

---

## Required Tag Shape

All publish runs — automated and manual — require a `mcp-server-v<semver>` tag.

Valid examples:

```
mcp-server-v0.1.0
mcp-server-v1.2.3-rc.1
```

Invalid examples (rejected by SemVer preflight step before any credential is used):

```
mcp-server-v-typo        # not a SemVer
mcp-server-vrc1          # not a SemVer
v0.1.0                   # wrong prefix
mcp-server-v0.1          # missing patch segment
```

The SemVer validation step runs _before_ checkout in each publish job inside
`release.yml`. Invalid tags are rejected before any code is checked out or
credentials are requested.

---

## Automated Publish (`release.yml`)

`release.yml` is the single production publish path for both npm and Docker.

### How a release flows

1. Merge a Conventional Commit (`feat:`, `fix:`, etc.) to `main`.
2. release-please opens a Release PR titled `chore: release main`. The `linked-versions`
   plugin groups the plugin and `mcp-server` components into one PR, so the title names
   neither a component nor a version.
3. A maintainer reviews and merges the Release PR.
4. `release.yml`'s `release-please` job reports what the merge released, and the jobs below
   it run from those outputs:

   | Job | Runs when | Does |
   |---|---|---|
   | `release-please` | every push to `main` | opens or updates the Release PR; creates the tags and GitHub Releases when it is merged |
   | `advance-stable` | the root (plugin) component was released | fast-forwards the `stable` branch to the release tag |
   | `publish-mcp` | `mcp-server` was released, or a forced re-publish with `publish_npm` | npm publish |
   | `docker-publish-sign` | `mcp-server` was released, or a forced re-publish with `publish_docker` | image push and cosign signature |
   | `deploy-web` | any component was released | Cloudflare Pages production deploy of `apps/web`; skips its deploy step while the Cloudflare secrets are absent |

   The jobs after `release-please` are independent of one another: one failing does not stop
   the others, so a failed `advance-stable` leaves the npm package, the image and the web
   deploy published.
5. `force_publish_tag` input: can re-publish a specific tag (e.g. after a transient
   OIDC failure). Must match `mcp-server-v<semver>`; rejected before checkout otherwise.
   The `publish_npm` and `publish_docker` inputs (both default on) choose which halves run.

### Publish gate scope: publishability, not correctness

`publish-mcp` runs the **publish** tier of `tests/e2e/distribution/release-gate-matrix.json`
via `pnpm publish-gate` (`tools/checks/src/publish-gate.mjs`, a matrix-driven runner that
mirrors `pages-release.mjs`). That tier is scoped to **publishability**: does the tarball
build correctly, contain the required files, carry an SBOM, and actually start when
unpacked (`smoke:tarball`, `smoke:packaged`, the packaged-daemon/server-mode node smokes,
`smoke:claude`, `smoke:codex`)? It also carries a fast, deterministic **correctness floor**
(`pnpm typecheck` + `pnpm test:mcp-node`) so an obviously broken tag never publishes.

It deliberately does **not** re-run the full browser/jsdom test matrix
(`pnpm test` = every vitest project, listed in `CONTRIBUTING.md`). That correctness is
already proven by **verify CI (`ci.yml`) at the identical tag SHA**: a release tag always
points at a commit that was pushed to `main`, and `ci.yml`'s `verify` job (gated on
`test-unit`, `test-jsdom`, `test-browser`) already ran against that exact commit before a
human merged the release PR. Re-running the same suite a second time inside `publish-mcp`
produced no new correctness signal — it only re-exposed an already-green commit to
environment flakes (three consecutive releases failed publish this way, each on a
different flake inside the re-run, while npm sat stuck at an older version). See
`ci-verify-coverage.test.ts` and `publish-gate-runner.test.ts` in
`tools/arch-lint/src/` for the automated guards that keep this
boundary from drifting.

A blocking cross-workflow dependency on verify's *reported* conclusion (rather than on
branch-protection having already required it) was considered and rejected: `publish-mcp`
only depends on `release-please`, not on `verify`, so querying verify's conclusion at
publish time races a same-push `ci.yml` run that may still be in progress, and would
require granting `actions: read` that the workflow does not otherwise need. If a stronger,
machine-checked guarantee is wanted later, add it as a non-blocking advisory annotation
first.

### `publish-mcp` job (npm OIDC provenance)

Steps (in order):

1. Validate `mcp-server-v<semver>` tag shape via `TAG` env var (not inline expression —
   prevents shell injection).
2. Checkout the release tag.
3. Install dependencies (Node 24 pinned; npm 11.x meets Trusted Publishing requirement).
4. `pnpm audit --prod --audit-level=high`: a high or critical advisory in a production
   dependency stops the publish.
5. `pnpm publish-gate`: runs the publish tier (typecheck, mcp-node floor, build,
   artifact checks, SBOM generation, tarball/packaged smokes) — see "Publish gate
   scope" above.
6. `verify-pack-contents`: the packed tarball carries the README and LICENSE and no test
   artifacts or internal `_artifacts`.
7. Upload SBOM as GitHub Actions artifact `npm-sbom-<run_id>` (retained 90 days,
   `if-no-files-found: error`).
8. `npm publish --access public --provenance` (OIDC Trusted Publishing, no NPM_TOKEN).

Permissions: `contents: read`, `id-token: write` (job-scoped, not workflow-root).
Environment: `production-npm`.

### `docker-publish-sign` job (keyless signing)

Steps (in order):

1. Validate `mcp-server-v<semver>` tag shape via `TAG` env var (same guard as npm job).
2. Checkout the release tag.
3. Install dependencies.
4. `pnpm publish-gate`, the same publishability tier the npm job runs (see "Publish gate
   scope" above), then `pnpm smoke:docker` and `pnpm smoke:docker-backup-restore`, the
   checks only a container can answer. It does **not** run `check:release-candidate:docker`:
   that aggregate chains `pnpm test`, the full matrix verify CI already ran at this SHA.
   Re-run on one runner at the tag, it failed the 0.0.20 image three times on three
   different load-dependent tests, and a re-run checks out the same tag, so a flake there
   blocks the image for that whole release. `check:release-candidate:docker` stays the
   local, full pre-release pass.
5. `docker/build-push-action` with `sbom: true` and `provenance: true` (OCI attestations).
6. `cosign sign --yes` using `DIGEST` and `IMAGE_REPO` env vars (not inline shell
   expansion); keyless signing via Sigstore OIDC, no private key material.

Permissions: `contents: read`, `id-token: write`, `packages: write` (job-scoped).
Environment: `production-docker`.

### `advance-stable` job (plugin channel)

Git-based plugin consumers (the Claude Code marketplace source ref, Codex `@stable`
marketplaces) resolve the `stable` branch, so plugin content ships when the Release PR
merges rather than on every push to `main`.

Steps (in order):

1. Check out with full history and tags.
2. Fetch the root release tag (`root_tag_name`) and verify it resolves to a commit.
3. `git push origin <tag-commit>:refs/heads/stable`, with **no force flag**.

Permissions: `contents: write`. No environment.

**It fails on a non-fast-forward.** If `stable` holds a commit that is not an ancestor of
the release tag (someone pushed to `stable` directly, or history on `main` was rewritten),
git refuses the push and the job goes red; the workflow never rewrites `stable` itself.
Plugin consumers stay on the previous `stable` until it is resolved. To recover:

1. Compare the branches: `git fetch origin && git log --oneline origin/stable ^<tag>` lists
   what `stable` has that the tag does not.
2. Decide what those commits are. If they belong, land them on `main` through a normal PR
   (a later release carries them); if they are stray, a maintainer resets `stable` to the
   tag deliberately, outside the workflow.
3. Re-run the failed job (`gh run rerun <run-id> --failed`): it re-reads the same tag and
   pushes again.

### `deploy-web` job (hosted app)

Builds `apps/web` and runs `wrangler pages deploy dist --project-name=kamiazya-whiteboard`
against production, through `cloudflare/wrangler-action`. The deploy step skips itself
when the Cloudflare secrets are not configured in `production-web`. The other deploy
paths for the same project are in [cloudflare-pages.md](deployment/cloudflare-pages.md).

Permissions: `contents: read`. Environment: `production-web`.

---

## Dry-Run Verification (`ci.yml`)

Every PR and push to `main` runs non-destructive dry-run checks in `ci.yml`.
No `id-token: write`, no registry push, no cosign — safe to run on any branch.

```bash
# Local dry-run (no publish, no id-token):
pnpm publish:dry-run

# Or run individual steps:
pnpm publish:dry-run:npm    # pnpm pack + SHA-512 + SBOM placeholder
pnpm publish:dry-run:docker # docker build (no push)
```

`ci.yml` jobs:

- `dry-run-npm`: installs, builds, runs `pnpm publish:dry-run:npm`, uploads tarball
  artifacts to `npm-tarball-dry-run` (`if-no-files-found: error`).
- `dry-run-docker`: installs, runs `pnpm publish:dry-run:docker`, uploads metadata to
  `docker-image-dry-run` (`if-no-files-found: warn` — Docker daemon may be unavailable).
- `packaged-smoke`: installs, builds, then runs `pnpm smoke:distribution:packaged:node` — the
  same **publish**-tier packaged-distribution smoke that `pnpm publish-gate` runs at
  release time — on every PR, so that gate cannot go stale between release tags without
  a PR-side failure.

---

## npm SBOM Artifact

SBOM generation for npm uses `@cyclonedx/cyclonedx-npm` (workspace devDependency,
lockfile-pinned at v4.x):

- **Why CycloneDX over syft**: pure Node.js package (no binary install), CycloneDX
  format aligns with the `signingStrategy: "npm-provenance"` in
  `supply-chain-policy.json`, version fixed via pnpm lockfile for deterministic CI output.

- **Lockfile binding**: the script uses `pnpm deploy --legacy --prod` from the workspace
  root, which reads `pnpm-lock.yaml` to install production dependencies at exact pinned
  versions — the same graph validated by `check:release-candidate`. The `--legacy` flag
  is required by pnpm v10. This avoids re-resolving `^` / `~` ranges independently at
  SBOM generation time. `cyclonedx-npm` is then run against the deployed directory with
  `--ignore-npm-errors` (suppresses `ELSPROBLEMS` for absent devDependencies, which are
  intentionally excluded from the prod-only deploy).

- **Output**: `packages/mcp-server/_artifacts/npm-sbom.cdx.json`
  Uploaded as GitHub Actions artifact `npm-sbom-<tag>` with 90-day retention.

- **Safe stdout contract** (`generate-npm-sbom.mjs`):
  Emits a JSON summary with: `sbomFile` (basename), `sbomBytes`, `checksum` (SHA-512),
  `tool`, `toolVersion`, `sbomFormat`, `specVersion`.
  Never emits: SBOM contents, dependency names, package paths, registry auth,
  OIDC material, or full build logs.

- **Script**: `packages/mcp-server/scripts/release/generate-npm-sbom.mjs`
  (a package script — `pnpm --filter @kamiazya/whiteboard-mcp generate:sbom:npm`,
  which is how `check:release-candidate` calls it; there is no root script of
  that name)

- **When it runs in CI**: `pnpm publish-gate` (used in the `publish-mcp` job) runs
  `generate-npm-sbom.mjs` as one of the publish-tier gates, before `npm publish`. This
  ensures the SBOM content regression tests in `sbom-policy.test.ts` always execute on
  the release path.

- **Staleness guard**: `generate-npm-sbom.mjs` also writes a sidecar fingerprint file,
  `packages/mcp-server/_artifacts/npm-sbom.inputs.json` (SHA-256 of `pnpm-lock.yaml`
  and `packages/mcp-server/package.json`, plus a SHA-512 of the SBOM file itself).
  `sbom-policy.test.ts` recomputes the current fingerprint before running its
  content-policy assertions, so a locally generated SBOM that predates a dependency
  change fails with an actionable "stale, run `pnpm --filter @kamiazya/whiteboard-mcp
  generate:sbom:npm`" message instead of reading as a false dependency-policy
  regression. See `packages/mcp-server/src/server/release/release-signing-provenance-sbom.md`
  for the full contract (current/stale/absent states).

---

## Docker SBOM and Provenance

Docker SBOM and provenance attestations are produced by `docker/build-push-action`
with `sbom: true` and `provenance: true`. These flags cause Buildkit to generate
and push OCI attestation manifests alongside the image layers. No custom signing
keys or bespoke signing formats are used.

The Docker image is keyless-signed by cosign via Sigstore OIDC. The signing
identity is tied to the GitHub Actions OIDC token of the `production-docker`
environment, not to any stored private key.

Verification:
```bash
cosign verify ghcr.io/kamiazya/whiteboard:<tag> \
  --certificate-identity-regexp "github.com/kamiazya/whiteboard" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

---

## Docker Release Candidate Verification

Run the Docker-specific gates before tagging a release that includes a new
image. These run in addition to — not instead of — the CI gates:

```sh
# Full Docker release verification (CI gates + Docker gates).
pnpm check:release-candidate:docker

# Or run the Docker-specific gates individually after check:release-candidate:
pnpm smoke:docker              # Docker image boots, serves MCP, auth smoke
pnpm smoke:docker-backup-restore  # backup → restore round-trip via volume mounts
```

The non-Docker release gates (unit tests, typecheck, distribution smokes,
etc.) are bundled in `pnpm check:release-candidate`. The Docker aggregate
runs CI gates first, then the two Docker-specific smokes:

```sh
pnpm check:release-candidate           # CI-equivalent gates (no Docker)
pnpm check:release-candidate:local     # above + mutation:contracts
pnpm check:release-candidate:docker    # CI gates + Docker gates (full docker release)
```

The machine-readable gate manifest lives at
`tests/e2e/distribution/release-gate-matrix.json`.

---

## Rollback and Retry

**npm**: npm does not support unpublish after 24 hours for scoped public packages.
Use `npm deprecate @kamiazya/whiteboard-mcp@<version> "use <next-version>"` to
mark a broken release deprecated rather than removing it.

To re-publish a corrected tarball for the same version, you must bump the version
(create a new Release PR via release-please). For hotfixes, use a patch bump
(`mcp-server-v0.1.1`).

**Docker**: GHCR images can be deleted or retracted via the GitHub Package management
UI or the GitHub API. Coordinate with any downstream users before removing an image.

**Force-publish via release.yml**: Use `force_publish_tag` input to re-run publishing
for an existing tag (e.g., after a transient OIDC failure or a failed image push). The
`publish_npm` and `publish_docker` booleans (both default on) choose which halves run, so
either can be retried alone: `npm publish` fails on a version npm already has, so retry
only a failed image push with `publish_npm` off, and `docker-publish-sign` re-tags
`latest` when it runs. A dispatch with no tag runs neither. The tag must match
`mcp-server-v<semver>` and the `production-npm` and `production-docker` environments
must approve.

---

## Placeholder Gate Policy

Two root scripts remain fail-closed placeholders:

```
publish:npm-provenance  →  exits 1 with "[publish:npm-provenance] not implemented"
publish:docker-sign     →  exits 1 with "[publish:docker-sign] not implemented"
```

These scripts exist in `package.json` as reservations for future locally-runnable
publish gates. They are referenced as `futureGateId` values in
`tests/e2e/distribution/supply-chain-policy.json`.

**Why they remain placeholders**: A publish gate that exits 1 unconditionally
cannot be used in the release gate matrix. Adding a failing script to the matrix
would block every `pnpm check:release-candidate` run. The gate will be promoted
to a real entry in `release-gate-matrix.json` only when the script becomes a
deterministic, non-destructive runnable gate (e.g., a dry-run validator that
checks credentials are present and reports readiness without actually publishing).

---

## Why `implementedNow` Remains `false`

`tests/e2e/distribution/supply-chain-policy.json` has `implementedNow: false` for
`npm-tarball` and `docker-image` artifacts.

`implementedNow: true` would imply that a runnable gate script exists in
`release-gate-matrix.json` for the publish step. It does not — the actual publish
runs inside GitHub Actions with OIDC tokens that are unavailable locally. Setting
`implementedNow: true` before a locally-runnable, fail-safe gate script exists
would create a false policy signal and cause drift tests to fail (the gate would
be expected in the matrix but the placeholder script would break it).

The flag will be flipped to `true` when:
- A non-destructive, locally-runnable `publish:npm-provenance` script exists
  (e.g., it validates publish prerequisites and reports readiness without publishing),
- AND that script is added to `release-gate-matrix.json` under the `publish` tier.
