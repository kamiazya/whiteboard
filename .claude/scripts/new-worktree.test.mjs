#!/usr/bin/env node
// Regression coverage for new-worktree.mjs's cross-package import of
// dev-port-lib.mjs. That import reaches into packages/mcp-server's internal
// scripts/dev/ directory via a relative filesystem path rather than a
// declared package dependency/export, so nothing in the module graph flags
// a future move/rename of that file — this test is what turns that failure
// mode from "silently wrong at runtime" into "loud in CI".
//
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('the relative path new-worktree.mjs imports dev-port-lib.mjs from resolves and exposes deriveDevPort', async () => {
  const devPortLibPath = resolve(__dirname, '../../packages/mcp-server/scripts/dev/dev-port-lib.mjs')
  const { deriveDevPort } = await import(devPortLibPath)

  assert.equal(typeof deriveDevPort, 'function')
  assert.equal(
    deriveDevPort({ repoRoot: '/repo', isMainCheckout: true, env: {} }),
    3099,
    'sanity-checks the actual imported function still behaves as new-worktree.mjs expects',
  )
})
