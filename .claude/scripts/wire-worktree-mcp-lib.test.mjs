#!/usr/bin/env node
// Regression coverage for wire-worktree-mcp-lib.mjs's pure planning logic:
// URL/argv construction, existing-config classification, the settings.json
// write-guard, and the stale-registration sweep. No real ~/.claude.json or
// `claude` CLI invocation happens here — that stays a manual verification
// step (see docs/contributing/development.md) precisely because this repo's
// dev-flow forbids CI from mutating developer-global state.
//
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMcpUrl,
  buildDesiredConfig,
  buildClaudeMcpAddArgs,
  classifyExistingConfig,
  planStaleSweep,
  verifyPostWrite,
  assertNotTrackedSettingsPath,
} from './wire-worktree-mcp-lib.mjs'

const SERVER_NAME = 'whiteboard-wt'

test('buildMcpUrl formats a derived port as the /mcp endpoint URL', () => {
  assert.equal(buildMcpUrl(3457), 'http://127.0.0.1:3457/mcp')
})

test('buildMcpUrl on the main-checkout port matches the canonical settings.json URL (drift guard)', () => {
  assert.equal(buildMcpUrl(3099), 'http://127.0.0.1:3099/mcp')
})

test('buildDesiredConfig derives the port from repoRoot only, ignoring WHITEBOARD_DEV_PORT', () => {
  const withoutOverride = buildDesiredConfig({ repoRoot: '/repo/wt-a', env: {} })
  const withOverride = buildDesiredConfig({
    repoRoot: '/repo/wt-a',
    env: { WHITEBOARD_DEV_PORT: '5555' },
  })

  assert.equal(withOverride.port, withoutOverride.port, 'override must not change the registered port')
  assert.equal(withOverride.overrideWarning, true, 'must flag that an active override was ignored')
  assert.equal(withoutOverride.overrideWarning, false)
})

test('buildDesiredConfig refuses to build a config for the main checkout', () => {
  assert.throws(() => buildDesiredConfig({ repoRoot: '/repo', env: {}, isMainCheckout: true }), /main checkout/i)
})

test('buildClaudeMcpAddArgs produces the exact argv for `claude mcp add`', () => {
  const desired = { name: SERVER_NAME, url: 'http://127.0.0.1:3457/mcp', authHeader: 'Authorization: Bearer whiteboard-dev' }
  assert.deepEqual(buildClaudeMcpAddArgs(desired), [
    'mcp',
    'add',
    '--transport',
    'http',
    '--scope',
    'local',
    '--header',
    'Authorization: Bearer whiteboard-dev',
    SERVER_NAME,
    'http://127.0.0.1:3457/mcp',
  ])
})

test('classifyExistingConfig: absent entry', () => {
  const desired = { url: 'http://127.0.0.1:3457/mcp', authHeader: 'Authorization: Bearer whiteboard-dev' }
  assert.equal(classifyExistingConfig(undefined, desired).outcome, 'absent')
})

test('classifyExistingConfig: identical entry is a no-op', () => {
  const desired = { url: 'http://127.0.0.1:3457/mcp', authHeader: 'Authorization: Bearer whiteboard-dev' }
  const existing = { type: 'http', url: desired.url, headers: { Authorization: 'Bearer whiteboard-dev' } }
  assert.equal(classifyExistingConfig(existing, desired).outcome, 'identical')
})

test('classifyExistingConfig: never treats a differing entry as identical', () => {
  const desired = { url: 'http://127.0.0.1:3457/mcp', authHeader: 'Authorization: Bearer whiteboard-dev' }
  const cases = [
    { type: 'http', url: desired.url, headers: {} }, // missing Authorization header
    { type: 'http', url: desired.url, headers: { Authorization: 'Bearer other-token' } }, // different bearer token
    { type: 'http', url: desired.url, headers: { Authorization: 'Bearer whiteboard-dev' }, extra: 'field' }, // extra unknown field
    { type: 'sse', url: desired.url, headers: { Authorization: 'Bearer whiteboard-dev' } }, // different transport
    { type: 'http', url: 'http://127.0.0.1:9999/mcp', headers: { Authorization: 'Bearer whiteboard-dev' } }, // different URL
  ]
  for (const existing of cases) {
    const result = classifyExistingConfig(existing, desired)
    assert.equal(result.outcome, 'conflict', `expected conflict for ${JSON.stringify(existing)}`)
    assert.ok(result.reason && result.reason.length > 0, 'conflict must carry an actionable reason')
  }
})

test('classifyExistingConfig: defensive against malformed/unknown shapes, never throws', () => {
  const desired = { url: 'http://127.0.0.1:3457/mcp', authHeader: 'Authorization: Bearer whiteboard-dev' }
  const malformed = [null, 'not-an-object', 42, {}, { url: 123 }, { type: 'http' }]
  for (const existing of malformed) {
    const result = classifyExistingConfig(existing, desired)
    assert.equal(result.outcome, 'conflict')
    assert.ok(result.reason)
  }
})

test('assertNotTrackedSettingsPath rejects any path inside tracked .claude/ config', () => {
  assert.throws(() => assertNotTrackedSettingsPath('/repo/.claude/settings.json'), /tracked/i)
  assert.doesNotThrow(() => assertNotTrackedSettingsPath('/repo/.claude/worktrees/foo/.mcp.json'))
})

test('verifyPostWrite: matching post-state reports wired', () => {
  const desired = { url: 'http://127.0.0.1:3457/mcp', authHeader: 'Authorization: Bearer whiteboard-dev' }
  const effective = { type: 'http', url: desired.url, headers: { Authorization: 'Bearer whiteboard-dev' } }
  assert.equal(verifyPostWrite(effective, desired).outcome, 'wired')
})

test('verifyPostWrite: divergent post-state (concurrent writer) reports post-write-mismatch, no overwrite', () => {
  const desired = { url: 'http://127.0.0.1:3457/mcp', authHeader: 'Authorization: Bearer whiteboard-dev' }
  const effective = { type: 'http', url: 'http://127.0.0.1:9999/mcp', headers: { Authorization: 'Bearer whiteboard-dev' } }
  const result = verifyPostWrite(effective, desired)
  assert.equal(result.outcome, 'post-write-mismatch')
  assert.ok(result.reason)
})

test('planStaleSweep: removes registrations whose worktree directory no longer exists', () => {
  const registered = [
    { name: 'whiteboard-wt', path: '/repo/.claude/worktrees/gone' },
    { name: 'whiteboard-wt', path: '/repo/.claude/worktrees/alive' },
  ]
  const liveWorktreePaths = ['/repo/.claude/worktrees/alive']
  const actions = planStaleSweep(registered, liveWorktreePaths)
  assert.deepEqual(actions, [{ action: 'remove', name: 'whiteboard-wt', path: '/repo/.claude/worktrees/gone' }])
})

test('planStaleSweep: empty registry yields zero actions', () => {
  assert.deepEqual(planStaleSweep([], ['/repo/.claude/worktrees/alive']), [])
})

test('planStaleSweep: all-live registry yields zero actions', () => {
  const registered = [{ name: 'whiteboard-wt', path: '/repo/.claude/worktrees/alive' }]
  assert.deepEqual(planStaleSweep(registered, ['/repo/.claude/worktrees/alive']), [])
})
