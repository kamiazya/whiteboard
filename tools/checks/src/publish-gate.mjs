#!/usr/bin/env node
// @whiteboard/checks — publish-gate runner.
//
// Executor for the `publish` tier of tests/e2e/distribution/release-gate-matrix.json.
//
// Scope: publishability only (build, artifact checks, SBOM, tarball/packaged smokes)
// plus a fast non-flaky correctness floor (typecheck + the mcp-node vitest project).
// The full browser/jsdom test matrix is NOT re-run: it already ran on this exact
// commit SHA in verify CI (see ci-verify-coverage.test.ts) — a release tag always
// points at a main-push commit that verify already validated. Re-running it here
// only re-exposed the tag to unrelated environment flakes without producing new
// correctness signal (see docs/contributing/releasing.md).
//
// No synthetic prerequisite is prepended — `build` is itself a matrix gate tagged
// requiredFor:"publish", so the matrix stays the single source of truth for order.

import { createTierRunner, runIfEntry } from './release-gate-tier.mjs'

export const { USAGE, planSteps, runSteps, parseArgs, main } = createTierRunner({
  name: 'publish-gate',
  tier: 'publish',
  description: `Runs the npm publish gates (the "publish" tier of
tests/e2e/distribution/release-gate-matrix.json), from the repo root, in matrix
order, fail-fast on the first non-zero exit.`,
})

runIfEntry(import.meta.url, main)
