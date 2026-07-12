# Release Publishing Guide

Operator runbook for publishing `@kamiazya/whiteboard-mcp` to npm and GHCR.

---

## Required GitHub Environments

Two protected environments must exist before any publish run:

| Environment | Job | Purpose |
|---|---|---|
| `production-npm` | `publish-mcp` | npm OIDC Trusted Publishing (no token required) |
| `production-docker` | `docker-publish-sign` | GHCR push + cosign keyless signing |

Both environments should require at least one reviewer before the job runs.
Without the environment protection, the `release.yml` publish guard is incomplete.

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
2. release-please opens a Release PR (`chore(main): release mcp-server vX.Y.Z`).
3. A maintainer reviews and merges the Release PR.
4. `release.yml` detects `mcp_release_created == true` and runs both publish jobs.
5. `force_publish_tag` input: can re-publish a specific tag (e.g. after a transient
   OIDC failure). Must match `mcp-server-v<semver>`; rejected before checkout otherwise.

### Publish gate scope: publishability, not correctness

`publish-mcp` runs the **publish** tier of `tests/e2e/distribution/release-gate-matrix.json`
via `pnpm publish-gate` (`tools/checks/src/publish-gate.mjs`, a matrix-driven runner that
mirrors `pages-release.mjs`). That tier is scoped to **publishability**: does the tarball
build correctly, contain the required files, carry an SBOM, and actually start when
unpacked (`smoke:tarball`, `smoke:packaged`, the packaged-daemon/server-mode node smokes,
`smoke:claude`, `smoke:codex`)? It also carries a fast, deterministic **correctness floor**
(`pnpm typecheck` + `pnpm test:mcp-node`) so an obviously broken tag never publishes.

It deliberately does **not** re-run the full browser/jsdom test matrix
(`pnpm test` = mcp-node + apps/web jsdom + web-browser). That correctness is
already proven by **verify CI (`ci.yml`) at the identical tag SHA**: a release tag always
points at a commit that was pushed to `main`, and `ci.yml`'s `verify` job (gated on
`test-unit`, `test-jsdom`, `test-browser`) already ran against that exact commit before a
human merged the release PR. Re-running the same suite a second time inside `publish-mcp`
produced no new correctness signal — it only re-exposed an already-green commit to
environment flakes (three consecutive releases failed publish this way, each on a
different flake inside the re-run, while npm sat stuck at an older version). See
`ci-verify-coverage.test.ts` and `publish-gate-runner.test.ts` in
`packages/mcp-server/src/server/release/` for the automated guards that keep this
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
4. `pnpm publish-gate`: runs the publish tier (typecheck, mcp-node floor, build,
   artifact checks, SBOM generation, tarball/packaged smokes) — see "Publish gate
   scope" above.
5. Upload SBOM as GitHub Actions artifact `npm-sbom-<tag>` (retained 90 days,
   `if-no-files-found: error`).
6. `npm publish --access public --provenance` (OIDC Trusted Publishing, no NPM_TOKEN).

Permissions: `contents: read`, `id-token: write` (job-scoped, not workflow-root).
Environment: `production-npm`.

### `docker-publish-sign` job (keyless signing)

Steps (in order):

1. Validate `mcp-server-v<semver>` tag shape via `TAG` env var (same guard as npm job).
2. Checkout the release tag.
3. Install dependencies.
4. `pnpm check:release-candidate:docker`: CI gates + Docker-specific gates.
5. `docker/build-push-action` with `sbom: true` and `provenance: true` (OCI attestations).
6. `cosign sign --yes` using `DIGEST` and `IMAGE_REPO` env vars (not inline shell
   expansion); keyless signing via Sigstore OIDC, no private key material.

Permissions: `contents: read`, `id-token: write`, `packages: write` (job-scoped).
Environment: `production-docker`.

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
  (called via root script `pnpm generate:sbom:npm`)

- **When it runs in CI**: `pnpm publish-gate` (used in the `publish-mcp` job) runs
  `generate-npm-sbom.mjs` as one of the publish-tier gates, before `npm publish`. This
  ensures the SBOM content regression tests in `sbom-policy.test.ts` always execute on
  the release path.

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
cosign verify ghcr.io/<org>/whiteboard-server:<tag> \
  --certificate-identity-regexp "github.com/kamiazya/whiteboard" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

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

**Force-publish via release.yml**: Use `force_publish_tag` input to re-run the npm
publish for an existing tag (e.g., after a transient OIDC failure). The tag must
match `mcp-server-v<semver>` and the `production-npm` environment must approve.

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
