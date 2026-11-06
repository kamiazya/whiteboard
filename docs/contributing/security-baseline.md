# Security baseline: the OpenSSF control matrix

This page records, control by control, where Whiteboard stands against the
OpenSSF supply-chain guidance and the standards it builds on: what is met and
where the evidence is, what is a gap the repository itself can close, and what
only the repository owner can do because it lives in GitHub settings, in an
account or in a decision about the project.

It is a record of the current state, not an aspiration. A row says **met**
only where a file, a workflow or a guard test shows it; a control whose
evidence sits in a setting nobody could read is marked as such.

Statuses:

| status | meaning |
|---|---|
| **met** | satisfied today; the evidence column says where |
| **gap-technical** | not satisfied, and closable by a change to this repository |
| **gap-owner** | not satisfied, and closable only by the owner (a setting, an account, an application or a project decision) |
| **planned** | arrives with the Rust core (ADR-0054; requirements QR-27 to QR-29 in the development quality requirements) |
| **n/a** | does not apply, with the reason |

## Sources

Each standard was read at its current version on 2026-11-06.

| standard | version read | what it is used for here |
|---|---|---|
| [OpenSSF Scorecard checks](https://github.com/ossf/scorecard/blob/main/docs/checks.md) | v5.6.0 | the automated score; measured locally below |
| [OpenSSF Security Baseline (OSPS Baseline)](https://baseline.openssf.org/versions/2026-08-28) | 2026-08-28 | the control set, levels 1 to 3 |
| [OpenSSF Best Practices Badge criteria](https://www.bestpractices.dev/en/criteria) | criteria as of 2026-11 | passing in full; silver and gold summarised |
| [Concise Guide for Developing More Secure Software](https://best.openssf.org/Concise-Guide-for-Developing-More-Secure-Software) | 2023-06-14 edition | the 29-item checklist the other guides refine |
| [npm Best Practices Guide](https://github.com/ossf/package-manager-best-practices/blob/main/published/npm.md) | main branch | lockfile, install, publishing and provenance practice |
| [SCM Platform Configuration Best Practices](https://best.openssf.org/SCM-BestPractices/) | main branch | branch protection, access and CI settings |
| [SLSA](https://slsa.dev/spec/v1.2/) | v1.2 | the Build track levels |
| [NIST SP 800-218 (SSDF)](https://csrc.nist.gov/pubs/sp/800/218/final) | v1.1 (Feb 2022); [Rev. 1 draft, v1.2](https://csrc.nist.gov/pubs/sp/800/218/r1/ipd) (Dec 2025) | the practice groups worth tracking |
| [CISA Secure by Design pledge](https://www.cisa.gov/securebydesign/pledge) | May 2024 | the seven goals, read for a single-maintainer open-source project |
| [ANSSI secure Rust guide](https://anssi-fr.github.io/rust-guide/) | current web edition | the Rust rules the core will follow |

## Measured: OpenSSF Scorecard, local run

The repository had never been scored: `api.scorecard.dev` answered 404.
`.github/workflows/scorecard.yml` now runs Scorecard weekly and publishes the
result. Before that, Scorecard v5.6.0 was run locally over this tree
(`scorecard --local=. --format=json`); the checks that need the GitHub API
(Branch-Protection, CI-Tests, CII-Best-Practices, Code-Review, Contributors,
Maintained, SBOM's release half, Signed-Releases, Webhooks) cannot run that way
and are judged from the REST API and the workflows instead.

| check | local score | status | evidence / fix / owner action |
|---|---|---|---|
| Binary-Artifacts | 10 | met | no binaries in the tree |
| Branch-Protection | API only | gap-owner | the REST API shows `main` protected with four required status checks (`build`, `pr-title`, `ci-gate`, `CodeQL`) enforced for everyone; the review settings were not readable (HTTP 403). Owner: confirm or enable a ruleset on `main` requiring a pull request, blocking force pushes and deletion, dismissing stale approvals, and applying to administrators |
| CI-Tests | API only | met | `ci.yml` runs on every pull request; `ci-gate` is required |
| CII-Best-Practices | API only | gap-owner | no badge yet. The application data is prepared [below](#best-practices-badge-application-data); applying is the owner's |
| Code-Review | API only | gap-owner | merges are by the single maintainer; AI review is not a human approval. Closes only with a second human reviewer |
| Contributors | API only | n/a | counts contributors from distinct organisations; nothing in the repository can change it |
| Dangerous-Workflow | 10 | met | no `pull_request_target` checkout of PR code; untrusted values read through `env:`; held by `preview-pr-deploy-label.test.ts` and `workflow-credentials.test.ts`, and by zizmor on every PR (below) |
| Dependency-Update-Tool | 10 | met | `.github/dependabot.yml` (npm and GitHub Actions, with cooldowns) |
| Fuzzing | 10 | met, partly | Scorecard credits the fast-check property suites; there is no coverage-guided fuzzer yet. Planned: cargo-fuzz targets for every untrusted-input entry (QR-29a to QR-29e), which Scorecard also detects |
| License | 9 | met | `LICENSE` is Apache-2.0, which the GitHub API reports. The local 9 is an artefact of local mode, which cannot ask the API for the licence identifier |
| Maintained | API only | met | commits weekly; the repository is older than the 90 days the check requires |
| Packaging | 10 | met | `release.yml` publishes to npm and GHCR |
| Pinned-Dependencies | 8 | gap-technical | every action is SHA-pinned (`workflow-supply-chain.test.ts`, repo-wide). `Dockerfile.server`'s two `FROM node:${NODE_VERSION}-slim` base images are not pinned by digest (Scorecard reports four lines, counting the two stages built on them). Fix: pin by digest through a build argument the release resolves from `.node-version`, and add the `docker` ecosystem to Dependabot so the digest is refreshed rather than frozen |
| SAST | 0 locally | met | CodeQL (default setup) is a required check on `main`; local mode cannot see check runs, which is the whole 0 |
| SBOM | API only | gap-technical | a CycloneDX SBOM is generated in CI (`sbom-npm`) and in every release run, and the container image carries an SBOM attestation, but no SBOM is attached to the GitHub release, which is where Scorecard awards the second half. Fix: attach `npm-sbom.cdx.json` to the release (see Signed-Releases) |
| Security-Policy | 10 | met | `SECURITY.md` |
| Signed-Releases | API only | gap-technical | the npm package is published with provenance and the image is cosign-signed, but the GitHub releases carry no assets (0 on each of the last three), and Scorecard reads only those. Fix: a release job that uploads the SBOM, a `SHA256SUMS` file and the provenance bundle to the GitHub release; it is the same job QR-27b requires for the native binaries |
| Token-Permissions | 8 | met | every workflow declares a root `permissions:` block granting no write, writes are per job (`workflow-supply-chain.test.ts`). The 8 was `release.yml` (no root block) and `preview-cleanup.yml` (root `deployments: write`), both fixed. The job-level writes left are the ones a job exists for: release-please and the stable-tag push (`contents: write`), the preview deployment records (`deployments: write`) |
| Vulnerabilities | 10 | met | no open OSV advisory; the two suppressed ones are published as VEX (below) |
| Webhooks | API only | gap-owner | needs admin read. Owner: any webhook should use a secret |

## Workflow static analysis: zizmor

`.github/workflows/zizmor.yml` runs [zizmor](https://docs.zizmor.sh) 1.32.0 at
its `regular` persona on every pull request and push to `main`, and fails the
job on a finding (template injection, credential persistence, dangerous
triggers, excessive permissions, and impostor commits behind a pinned SHA).
Locally: `uvx zizmor@1.32.0 .github/`. The configuration is
`.github/zizmor.yml`; `workflow-supply-chain.test.ts` holds that the job fails
rather than uploading, at a pinned version, with a read-only token.

Measured over `.github/` on 2026-11-06, the `regular` persona raised three
findings outside `ci.yml`, all deliberate and now suppressed with the reason
beside each: the stable-tag job's persisted checkout token, the privileged
`workflow_run` half of the preview build/deploy split, and the setup action's
exact-pinned corepack install. Its `self-repository` suggestion (24 sites, 13
of them in `ci.yml`) is disabled in the config, because the guards name the
local action by its `./` path. Status: **met**, and a gate once the owner makes
the `zizmor` check required.

The stricter `auditor` persona, which gates nothing here, adds what is worth
knowing: `RELEASE_PLEASE_TOKEN` and `SONAR_TOKEN` are repository secrets used
outside a deployment environment (gap-owner: move each into an environment
bound to its one job), and constant-valued expressions such as
`${{ matrix.shard }}` are expanded inline in `run:` blocks, eight lines in
`ci.yml` and one in `sonarqube.yml` — not exploitable, since none carries
attacker-controlled text, but passing them through `env:` would make the
auditor persona clean too.

## OSPS Baseline (2026-08-28)

### Level 1

| control | requirement, in short | status | evidence / fix / owner action |
|---|---|---|---|
| OSPS-AC-01.01 | MFA for access to sensitive resources | gap-owner | Owner: require 2FA on the account (and on any organisation that later owns the repository) and on npm |
| OSPS-AC-02.01 | new collaborators get least privilege by default | gap-owner | a GitHub setting; owner to confirm the base permission is read |
| OSPS-AC-03.01 | direct commits to the primary branch are prevented | gap-owner | required status checks block a direct push today; owner to confirm "require a pull request" is on (see Branch-Protection) |
| OSPS-AC-03.02 | deleting the primary branch requires confirmation | gap-owner | owner to confirm deletion is restricted in the ruleset |
| OSPS-BR-01.01 | untrusted CI metadata is sanitised | met | branch names and PR fields read through `env:` and normalised (`preview_label()`); `preview-pr-deploy-label.test.ts` |
| OSPS-BR-01.03 | untrusted code cannot reach privileged credentials | met | preview build and deploy are split across `pull_request` and `workflow_run`; the deploy job fetches nothing unlocked (`workflow-hygiene.test.ts`, `workflow-credentials.test.ts`) |
| OSPS-BR-03.01 | official channels are encrypted | met | GitHub, npm, GHCR and the hosted app are HTTPS only |
| OSPS-BR-03.02 | distribution channels are authenticated | met | npm and GHCR over TLS, with provenance and signatures |
| OSPS-BR-07.01 | secrets are kept out of version control | met, partly | `secretlint` blocks a staged secret at pre-commit (`lefthook.yml`). Fix: run it in CI too, since a hook can be skipped (an integrator item for `ci.yml`). Owner: enable GitHub secret scanning push protection |
| OSPS-DO-01.01 | user guides for basic functionality | met | `docs/tutorials`, `docs/how-to` |
| OSPS-DO-02.01 | a guide for reporting defects | met | `.github/ISSUE_TEMPLATE/bug_report.yml` |
| OSPS-GV-02.01 | a public discussion mechanism | met | GitHub issues and pull requests |
| OSPS-GV-03.01 | the contribution process is documented | met | `CONTRIBUTING.md` |
| OSPS-LE-02.01 | source licence is OSI-approved | met | Apache-2.0 |
| OSPS-LE-02.02 | released-asset licence is OSI-approved | met | the same licence; the npm tarball's `license` field |
| OSPS-LE-03.01 | licence file in the repository | met | `LICENSE` |
| OSPS-LE-03.02 | licence shipped with released assets | met | `packages/mcp-server/LICENSE`, checked into the tarball by `verify-pack-contents` |
| OSPS-QA-01.01 | repository publicly readable at a static URL | met | `https://github.com/kamiazya/whiteboard` |
| OSPS-QA-01.02 | public record of changes, authors and times | met | git history |
| OSPS-QA-02.01 | dependency list for direct dependencies | met | each `package.json` and `pnpm-lock.yaml` |
| OSPS-QA-04.01 | list of codebases when there are several | n/a | one repository |
| OSPS-QA-05.01 | no generated executables in version control | met | Scorecard Binary-Artifacts 10 |
| OSPS-QA-05.02 | no unreviewable binaries in version control | met | the binaries tracked are PNG images (documentation and screenshot fixtures) and TTF font files; none is a build output |
| OSPS-VM-02.01 | security contacts documented | met | `SECURITY.md` (private vulnerability reporting) and `.github/CODEOWNERS` |

### Level 2

| control | requirement, in short | status | evidence / fix / owner action |
|---|---|---|---|
| OSPS-AC-04.01 | a task with no permissions specified gets the lowest | met | every workflow declares a root block, and none grants a write there (`workflow-supply-chain.test.ts`) |
| OSPS-BR-02.01 | each release has a unique version | met | release-please, semver tags |
| OSPS-BR-04.01 | each release has a log of functional and security changes | met | `CHANGELOG.md`, `packages/mcp-server/CHANGELOG.md`; advisories linked from the fixing release (`SECURITY.md`) |
| OSPS-BR-05.01 | standard tooling to ingest dependencies | met | pnpm with `--frozen-lockfile`, `npm ci` for the deploy tooling |
| OSPS-BR-06.01 | releases signed or in a signed manifest | met | npm provenance (Sigstore), cosign keyless signature and attestations on the image |
| OSPS-DO-06.01 | how dependencies are selected, obtained and tracked | met | [Dependencies](#dependencies-how-they-are-selected-obtained-and-tracked) below |
| OSPS-DO-07.01 | build instructions | met | `CONTRIBUTING.md` quick start, [development](development.md) |
| OSPS-GV-01.01 | list of members with access to sensitive resources | gap-owner | drafted in [Project members](#project-members-and-roles) from `CODEOWNERS`; collaborators were not readable here, so the owner confirms the list |
| OSPS-GV-01.02 | roles and responsibilities | gap-owner | drafted in the same section; the owner confirms it |
| OSPS-GV-03.02 | contributor guide with acceptance requirements | met | `CONTRIBUTING.md` (pull request checklist, commit rules), [review-checklist](review-checklist.md) |
| OSPS-LE-01.01 | contributors assert authorisation on every commit | gap-owner | no DCO or CLA. A decision first (DCO sign-off is the usual choice); enforcement is then the DCO GitHub App or a check over `Signed-off-by` trailers |
| OSPS-QA-03.01 | status checks pass before merging to the primary branch | met | four required checks, enforced for everyone |
| OSPS-QA-06.01 | CI runs automated tests before a change is accepted | met | `ci.yml`, aggregated in the required `ci-gate` |
| OSPS-SA-01.01 | design documentation of actions and actors | met | [explanation/architecture](../explanation/architecture.md), [explanation/security-model](../explanation/security-model.md) |
| OSPS-SA-02.01 | external software interfaces described | met | `docs/reference/` (configuration, export formats, the `x-whiteboard` schema), [architecture/wire-protocol](architecture/wire-protocol.md) |
| OSPS-SA-03.01 | a security assessment | met | [explanation/security-model](../explanation/security-model.md), with its "Current limitations" |
| OSPS-VM-01.01 | CVD policy with a response timeframe | met | `SECURITY.md` (72-hour acknowledgement, 14-day high-severity target, coordinated disclosure) |
| OSPS-VM-03.01 | private vulnerability reporting | met | GitHub private vulnerability reporting is enabled (REST API: `enabled: true`) |
| OSPS-VM-04.01 | discovered vulnerabilities published | met | the GitHub Security Advisory process in `SECURITY.md`; no advisory has been needed yet |

### Level 3

| control | requirement, in short | status | evidence / fix / owner action |
|---|---|---|---|
| OSPS-AC-04.02 | jobs get only the privileges they need | met | per-job grants; `ci-policy.test.ts` scopes `packages: write` to one job, `workflow-supply-chain.test.ts` scopes `id-token: write` in the Scorecard workflow |
| OSPS-BR-01.04 | trusted collaborator input is validated | met | `release.yml`'s `force_publish_tag` is read through `env:` and checked against the checked-out tag and the dispatched ref before anything publishes |
| OSPS-BR-02.02 | assets associated with the release identifier | met | the npm version and the image tag are the release tag's version |
| OSPS-BR-07.02 | a policy for managing secrets | gap-owner | the practice is written down in [Secrets](#secrets) below; a rotation cadence is the owner's to set |
| OSPS-DO-03.01 | instructions to verify integrity and authenticity | met | `SECURITY.md` "Verifying a release"; the cosign verification commands in [releasing](releasing.md) |
| OSPS-DO-03.02 | instructions to verify the release author's identity | met | the cosign certificate identity and the npm provenance's workflow identity, in the same places |
| OSPS-DO-04.01 | scope and duration of support per release | met | `SECURITY.md` "Supported Versions" |
| OSPS-DO-05.01 | when releases stop receiving security updates | met | the same table: a version stops when a newer one is published |
| OSPS-GV-04.01 | collaborators reviewed before escalated permissions | gap-owner | a policy only the owner can adopt; suggested text in [Project members](#project-members-and-roles) |
| OSPS-QA-02.02 | compiled released assets ship with an SBOM | met, planned | the image carries an SBOM attestation; the npm package is not compiled. The native binaries get `cargo auditable` plus a CycloneDX SBOM (QR-27a) |
| OSPS-QA-04.02 | subprojects as strict as the primary codebase | n/a | one repository |
| OSPS-QA-06.02 | when and how tests run is documented | met | [testing](testing.md), `CONTRIBUTING.md` |
| OSPS-QA-06.03 | a policy that major changes add or update tests | met | test-first workflow in `AGENTS.md`, [testing](testing.md) |
| OSPS-QA-07.01 | one non-author human approval before merging | gap-owner | needs a second human maintainer |
| OSPS-SA-03.02 | threat model and attack surface analysis | met | [explanation/security-model](../explanation/security-model.md) — trust boundaries and protections per runtime |
| OSPS-VM-04.02 | non-affecting vulnerabilities in a VEX document | met | `.github/security/whiteboard.openvex.json`, held equal to the audit suppressions by `vex-audit-ignores.test.ts` |
| OSPS-VM-05.01 | threshold for remediating SCA findings | gap-technical | `SECURITY.md` "Remediation thresholds" sets the vulnerability threshold; no license-finding threshold is stated yet |
| OSPS-VM-05.02 | SCA violations addressed before any release | gap-technical | `release.yml` audits the lockfile and the packed tarball before the npm package publishes; the container image (`docker-publish-sign` needs `build-docker`, not the audit) and the web deploy are not gated on an audit |
| OSPS-VM-05.03 | every change checked for vulnerable or malicious dependencies, and blocked | gap-owner | `pnpm audit:prod` in CI, `dependency-review.yml` on every PR, and `minimumReleaseAge` (seven days) in `pnpm-workspace.yaml` against a freshly published malicious version. Owner: add `dependency-review` as a required check, since it runs as its own workflow outside `ci-gate` |
| OSPS-VM-06.01 | threshold for remediating SAST findings | met | `SECURITY.md` "Remediation thresholds" |
| OSPS-VM-06.02 | every change checked for weaknesses, and blocked | met | CodeQL is a required check |

## Best Practices Badge

### Passing

The passing level has 67 active criteria. "attest" means the criterion is a
statement the owner makes on the application form; the evidence is what to
point it at.

| criterion | status | evidence |
|---|---|---|
| description_good, interact, contribution, contribution_requirements | met | `README.md`, `CONTRIBUTING.md` |
| floss_license, floss_license_osi, license_location | met | Apache-2.0, `LICENSE` |
| documentation_basics, documentation_interface | met | `docs/`, `docs/reference/` |
| sites_https, english | met | GitHub, npm, the hosted app; all docs in English |
| discussion, maintained | met | issues and pull requests; weekly commits |
| repo_public, repo_track, repo_interim, repo_distributed | met | public git repository; pull requests carry interim work |
| version_unique, version_semver, version_tags | met | release-please, semver tags |
| release_notes, release_notes_vulns | met | the changelogs; advisories linked from the fixing release (`SECURITY.md`) |
| report_process, report_tracker, report_responses, enhancement_responses, report_archive | met, attest | issue templates; the public issue tracker is the archive. The owner attests response practice |
| vulnerability_report_process, vulnerability_report_private, vulnerability_report_response | met | `SECURITY.md`; private reporting enabled; 72-hour acknowledgement |
| build, build_common_tools, build_floss_tools | met | pnpm, TypeScript, Vite, tsdown |
| test, test_invocation, test_most, test_continuous_integration | met | vitest, `pnpm test`, CI on every PR |
| test_policy, tests_are_added, tests_documented_added | met | `AGENTS.md`, `CONTRIBUTING.md`, [testing](testing.md) |
| warnings, warnings_fixed, warnings_strict | met | `tsc` strict, Biome with `--error-on-warnings` |
| know_secure_design, know_common_errors | attest | owner attests; [explanation/security-model](../explanation/security-model.md) is the evidence of applied knowledge |
| crypto_published, crypto_call, crypto_floss, crypto_keylength, crypto_working, crypto_weaknesses, crypto_pfs, crypto_random | met, attest | platform crypto only (WebCrypto, `node:crypto`, WebAuthn passkeys, TLS left to the platform or the operator); nothing hand-rolled |
| crypto_password_storage | n/a | no passwords are stored; authentication is by passkey and bearer credential (security model) |
| delivery_mitm, delivery_unsigned | met | HTTPS delivery; npm provenance, cosign signatures |
| vulnerabilities_fixed_60_days, vulnerabilities_critical_fixed | met | no open advisory; audits gate merges and releases |
| no_leaked_credentials | met | `secretlint` pre-commit; publishing uses OIDC with no stored npm token |
| static_analysis, static_analysis_common_vulnerabilities, static_analysis_fixed, static_analysis_often | met | CodeQL on every PR, Biome |
| dynamic_analysis, dynamic_analysis_unsafe, dynamic_analysis_enable_assertions, dynamic_analysis_fixed | met | property-based tests with fast-check, browser and end-to-end suites; the memory-unsafe half is n/a for TypeScript and planned for Rust (sanitisers with the fuzzers, QR-28f) |

Nothing at the passing level is a technical gap; the only remaining step is
the application itself.

### Silver and gold

Of the criteria above passing, these do not hold today:

- **Owner decisions or people**: `dco` (silver; see OSPS-LE-01.01),
  `governance` and `roles_responsibilities` (silver; see Project members),
  `access_continuity` and `bus_factor` (silver; gold requires two people who
  could carry the project on), `two_person_review` and `require_2FA` (gold),
  `contributors_unassociated` (gold), `security_review` (gold).
- **Technical**: `documentation_roadmap` (silver; no public roadmap page),
  `signed_releases` in the GitHub-release sense (silver; the Signed-Releases
  fix above), `test_statement_coverage80` (silver) and
  `test_statement_coverage90`/`test_branch_coverage80` (gold; `pnpm coverage`
  measures but sets no floor — the Rust side gets floors in QR-18),
  `build_reproducible` (gold; planned for the binaries, QR-28e),
  `copyright_per_file`/`license_per_file` (gold; no SPDX headers), and
  `hardening`/`hardened_site` (gold; not yet assessed against the criteria).

## Best Practices badge application data

The application at <https://www.bestpractices.dev/en/projects/new> asks for
the following. Everything here can be pasted as it stands.

| field | value |
|---|---|
| project name | Whiteboard |
| description | A local-first whiteboard and document workspace, with an MCP server (`@kamiazya/whiteboard-mcp`) that lets AI assistants read and edit it |
| homepage / repository | `https://github.com/kamiazya/whiteboard` |
| licence | Apache-2.0 |
| contribution | `https://github.com/kamiazya/whiteboard/blob/main/CONTRIBUTING.md` |
| vulnerability report process | `https://github.com/kamiazya/whiteboard/blob/main/SECURITY.md` |
| build | `pnpm install --frozen-lockfile && pnpm build` |
| tests | `pnpm test`; CI: `https://github.com/kamiazya/whiteboard/actions/workflows/ci.yml` |
| static analysis | CodeQL (required check), Biome |
| release notes | `CHANGELOG.md`, `packages/mcp-server/CHANGELOG.md` |

Once the project has an id, the README badge is
`[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/<id>/badge)](https://www.bestpractices.dev/projects/<id>)`.
The Scorecard badge,
`[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/kamiazya/whiteboard/badge)](https://scorecard.dev/viewer/?uri=github.com/kamiazya/whiteboard)`,
works after the first run of `scorecard.yml` on `main`. Neither badge is in the
README yet, because a badge for a result that does not exist yet would only
show "unknown".

## SLSA (v1.2, Build track)

| level | status | evidence / fix |
|---|---|---|
| Build L1 — provenance exists | met | npm provenance; image provenance attestation |
| Build L2 — hosted build platform, signed provenance | met | both produced on GitHub-hosted runners and signed through Sigstore OIDC |
| Build L3 — hardened builds, unforgeable provenance | gap-technical | the provenance is generated inside the job that builds, so a compromised build step could influence it. Fix: generate it from an isolated reusable workflow (GitHub artifact attestations from a reusable workflow, or `slsa-github-generator`). Planned for the native binaries and wasm artifacts (QR-27b), and the same change can cover the npm tarball |

### Planned evidence for the native binaries

ADR-0054 ships the core as per-OS native binaries on npm. What those releases
will carry, so this matrix does not have to be re-derived when they land:

- **npm trusted publishing (OIDC) per package.** Each per-platform package and
  the launcher package is a separate npm package, and each needs its own
  trusted-publisher entry on npmjs.com naming `release.yml` — a registry
  setting per package, so an owner action at the first publish of each — and
  `npm publish --provenance` from that workflow (QR-27b).
- **`cargo auditable`** embeds the resolved dependency tree in each binary, so
  a scanner can audit a binary with no SBOM beside it (QR-27a).
- **A CycloneDX SBOM** per binary from `cargo-cyclonedx` (QR-27a; OSPS-QA-02.02).
- **`THIRD-PARTY-NOTICES`** generated by `cargo-about` from the same
  dependency tree, shipped beside each binary so every bundled licence is
  carried with the asset (OSPS-LE-03.02 for the binaries).
- **Build provenance** for each binary and wasm artifact as GitHub artifact
  attestations, and a `SHA256SUMS` file on the GitHub release (QR-27b), which
  also closes Scorecard's Signed-Releases and SBOM release halves.

## NIST SSDF (SP 800-218)

The practice groups worth tracking for a project this size, and where each
stands. Rev. 1 (v1.2) is a draft and changes none of these mappings.

| practice | status | evidence |
|---|---|---|
| PO.1 — security requirements defined | met | the development quality requirements, this page |
| PO.3 — supporting toolchains | met | CI, `tools/arch-lint`, `tools/checks` |
| PO.5 — secure build environments | met | least-privilege tokens, SHA-pinned actions, OIDC publishing |
| PS.1 — code protected from unauthorised change | gap-owner | the branch rules in Branch-Protection |
| PS.2 — release integrity verifiable | met | provenance, signatures, `SECURITY.md` "Verifying a release" |
| PS.3 — releases archived with their provenance and SBOM | gap-technical | SBOM and provenance exist but are not attached to the GitHub release (Signed-Releases) |
| PW.1 — design meets security requirements | met | [explanation/security-model](../explanation/security-model.md) |
| PW.4 — reuse of well-secured software | met | [Dependencies](#dependencies-how-they-are-selected-obtained-and-tracked) |
| PW.7 — code review and analysis | met, partly | CodeQL and automated review; human second review is gap-owner |
| PW.8 — executable testing, fuzzing | met, planned | property, browser and end-to-end suites; fuzzing with the Rust core (QR-29) |
| RV.1 — vulnerabilities identified continuously | met | daily `audit.yml`, Dependabot, Scorecard |
| RV.2 — vulnerabilities assessed and remediated | met | `SECURITY.md` thresholds, VEX for the non-exploitable |
| RV.3 — root causes analysed | met | a regression test lands with every fix (`AGENTS.md`) |

## CISA Secure by Design pledge

Read for an open-source project with a single maintainer, the seven goals map
as follows: **MFA** is OSPS-AC-01.01 (gap-owner). **Default passwords** do not
exist: the daemon is reached over an owner-only socket and server mode defers
to the operator's identity provider. **Reducing classes of vulnerability** is
the move to a memory-safe Rust core (ADR-0054) with
`unsafe` forbidden. **Security patches** reach users through the npm `latest`
tag and the image's `latest`. **A vulnerability disclosure policy** is
`SECURITY.md`. **CVE transparency** is the advisory process, with a CWE in each
advisory. **Evidence of intrusions** is out of scope for a local-first tool;
server mode logs through the daemon's structured logger, which the operator
collects.

## ANSSI secure Rust guide

Relevant once the Rust core lands, and already reflected in the quality
requirements: a stable pinned toolchain with rustfmt and clippy at deny level
(QR-1), dependency auditing with cargo-deny and an `unsafe` ledger for
dependencies (QR-27a, QR-28c), no `unsafe` in project code, explicit overflow
behaviour and panic discipline (QR-28 group), bounded parsing of untrusted
input (QR-28b), and FFI and wasm boundaries kept narrow (ADR-0054 decisions 1
and 6).

## Dependencies: how they are selected, obtained and tracked

- **Selected** against the runtime criterion in the architecture map: a
  package added to a shared-layer package is recorded, with what was checked,
  in `tools/arch-lint/src/architecture-map.ts`'s allowed-dependency lists,
  which the build enforces.
- **Obtained** only through the lockfile: `pnpm install --frozen-lockfile`
  everywhere, install scripts off except for an allowlist, and
  `minimumReleaseAge` holding a newly published version back for seven days.
- **Tracked** by Dependabot (npm and GitHub Actions, with cooldowns), the
  daily `audit.yml`, `pnpm audit:prod` and Dependency Review on every change,
  and a CycloneDX SBOM generated in CI and in every release.

## Secrets

What exists today, for OSPS-BR-07.02:

- **No long-lived publishing credential.** npm publishing and image signing
  use GitHub OIDC; there is no npm token.
- **Repository secrets** are `RELEASE_PLEASE_TOKEN` (a token that lets
  release-please's pull requests trigger CI) and the Cloudflare deploy
  credentials, the latter scoped to the deployment environments and handed
  only to the deploy step (`workflow-hygiene.test.ts`).
- **In the tree**, `secretlint` blocks a staged secret at pre-commit.

The owner sets the rotation cadence for the two stored credentials and
records it here.

## Project members and roles

Drafted from `.github/CODEOWNERS`; the owner confirms it.

- **kamiazya** — owner and sole maintainer: merges to `main`, cuts releases,
  holds the npm package, the GHCR image and the Cloudflare project, and
  receives private vulnerability reports.

Suggested policy for OSPS-GV-04.01, for the owner to adopt or replace:
write access or any release credential is granted only to a contributor whose
merged contributions the owner has reviewed, and is recorded in this list in
the same change.

## Owner actions

The items above that only the owner can close, in one list:

1. Require 2FA on the GitHub account and on npm (OSPS-AC-01.01).
2. Confirm or add a ruleset on `main`: pull request required, force push and
   deletion blocked, stale approvals dismissed, applies to administrators
   (Branch-Protection, OSPS-AC-03.01/.02).
3. Add `dependency-review` as a required status check (OSPS-VM-05.03).
4. Enable secret scanning push protection (OSPS-BR-07.01).
5. Confirm the base collaborator permission is read (OSPS-AC-02.01).
6. Confirm the member list and roles above; adopt the escalation policy
   (OSPS-GV-01.01/.02, OSPS-GV-04.01).
7. Decide DCO or CLA (OSPS-LE-01.01).
8. Set a rotation cadence for `RELEASE_PLEASE_TOKEN` and the Cloudflare
   credentials (OSPS-BR-07.02).
9. Apply for the Best Practices badge with the data above, then add both
   badges to the README.
10. Check that any webhook uses a secret (Webhooks).
11. Make `zizmor` a required status check, and move `RELEASE_PLEASE_TOKEN`
    and `SONAR_TOKEN` into deployment environments bound to the jobs that
    use them.
12. At each new npm package's first publish (the per-platform binaries),
    register `release.yml` as its trusted publisher on npmjs.com.

Two need people rather than settings: a second human reviewer (Code-Review,
OSPS-QA-07.01) and a second person able to carry the project on (silver
`access_continuity`, gold `bus_factor`).
