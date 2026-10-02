#!/usr/bin/env node
// @whiteboard/checks — pages-release runner.
//
// Executor for the `pages-release` tier of tests/e2e/distribution/release-gate-matrix.json.
// `pnpm build` runs first because the artifact gates read apps/web/dist/.
//
// smoke:preview-origin needs Playwright and a local 127.0.0.1 HTTP bind; it fails with
// EPERM in a network-restricted sandbox and runs green in a normal environment.

import { createTierRunner, runIfEntry } from './release-gate-tier.mjs'

export const { USAGE, planSteps, runSteps, parseArgs, main } = createTierRunner({
  name: 'pages-release',
  tier: 'pages-release',
  prerequisites: [{ label: 'build', command: 'pnpm build' }],
  description: `Runs the Cloudflare Pages release gates (the "pages-release" tier of
tests/e2e/distribution/release-gate-matrix.json), from the repo root, in order:
  1. pnpm build
  2. each pages-release gate command, fail-fast on the first non-zero exit

Note: smoke:preview-origin needs Playwright and a local 127.0.0.1 HTTP bind
(it fails with EPERM in a network-restricted sandbox).`,
})

runIfEntry(import.meta.url, main)
