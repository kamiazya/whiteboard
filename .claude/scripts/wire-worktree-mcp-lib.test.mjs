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
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildMcpUrl,
  buildDesiredConfig,
  buildClaudeMcpAddArgs,
  classifyExistingConfig,
  planStaleSweep,
  verifyPostWrite,
  assertNotTrackedSettingsPath,
  resolveMainCheckoutRoot,
  removeStaleEntriesFromConfig,
  redactBearerTokens,
  redactUrlCredentials,
} from './wire-worktree-mcp-lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

test('buildDesiredConfig defaults to the tracked entry\'s own name ("whiteboard"), not a distinct name — verified against the real CLI: a local-scope registration under the SAME name cleanly shadows the tracked project-scope .mcp.json entry, so an agent never has to choose between two visibly different whiteboard-ish MCP servers', () => {
  const desired = buildDesiredConfig({ repoRoot: '/repo/wt-a', env: {} })
  assert.equal(desired.name, 'whiteboard')
})

test('buildDesiredConfig refuses to build a config for the main checkout', () => {
  assert.throws(() => buildDesiredConfig({ repoRoot: '/repo', env: {}, isMainCheckout: true }), /main checkout/i)
})

test('buildDesiredConfig authenticates with a custom WHITEBOARD_TOKEN when set', () => {
  const withCustomToken = buildDesiredConfig({
    repoRoot: '/repo/wt-a',
    env: { WHITEBOARD_TOKEN: 'my-custom-token' },
  })
  assert.equal(withCustomToken.authHeader, 'Authorization: Bearer my-custom-token')
})

test('buildDesiredConfig falls back to the package-script default token when WHITEBOARD_TOKEN is unset', () => {
  const withDefaultToken = buildDesiredConfig({ repoRoot: '/repo/wt-a', env: {} })
  assert.equal(withDefaultToken.authHeader, 'Authorization: Bearer whiteboard-dev')
})

test('buildClaudeMcpAddArgs produces the exact argv for `claude mcp add` — <name> <url> must come right after --transport http, real-CLI-verified: putting them after --scope/--header makes commander report "missing required argument \'name\'"', () => {
  const desired = { name: SERVER_NAME, url: 'http://127.0.0.1:3457/mcp', authHeader: 'Authorization: Bearer whiteboard-dev' }
  assert.deepEqual(buildClaudeMcpAddArgs(desired), [
    'mcp',
    'add',
    '--transport',
    'http',
    SERVER_NAME,
    'http://127.0.0.1:3457/mcp',
    '--scope',
    'local',
    '--header',
    'Authorization: Bearer whiteboard-dev',
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
    { type: 'http', url: desired.url, headers: { Authorization: 'Bearer whiteboard-dev', someExtra: 'x' } }, // extra unexpected header
  ]
  for (const existing of cases) {
    const result = classifyExistingConfig(existing, desired)
    assert.equal(result.outcome, 'conflict', `expected conflict for ${JSON.stringify(existing)}`)
    assert.ok(result.reason && result.reason.length > 0, 'conflict must carry an actionable reason')
  }
})

test('classifyExistingConfig: a conflicting existing URL is redacted (no userinfo/query) in the reported reason', () => {
  const desired = { url: 'http://127.0.0.1:3457/mcp', authHeader: 'Authorization: Bearer whiteboard-dev' }
  const existing = {
    type: 'http',
    url: 'http://user:hunter2@127.0.0.1:9999/mcp?token=super-secret',
    headers: { Authorization: 'Bearer whiteboard-dev' },
  }
  const result = classifyExistingConfig(existing, desired)
  assert.equal(result.outcome, 'conflict')
  assert.ok(!result.reason.includes('hunter2'), 'must not leak URL userinfo')
  assert.ok(!result.reason.includes('super-secret'), 'must not leak a URL query-string secret')
})

test('redactUrlCredentials: strips userinfo and query string, keeps origin and path', () => {
  assert.equal(
    redactUrlCredentials('http://user:hunter2@127.0.0.1:9999/mcp?token=super-secret'),
    'http://127.0.0.1:9999/mcp',
  )
})

test('redactUrlCredentials: leaves a credential-free URL unchanged', () => {
  assert.equal(redactUrlCredentials('http://127.0.0.1:3457/mcp'), 'http://127.0.0.1:3457/mcp')
})

test('redactUrlCredentials: returns non-URL input as-is rather than throwing', () => {
  assert.equal(redactUrlCredentials('not-a-url'), 'not-a-url')
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

test('assertNotTrackedSettingsPath rejects the settings.local.json variant', () => {
  assert.throws(() => assertNotTrackedSettingsPath('/repo/.claude/settings.local.json'), /tracked/i)
})

test('assertNotTrackedSettingsPath rejects repo-root-relative spellings (no leading slash)', () => {
  assert.throws(() => assertNotTrackedSettingsPath('.claude/settings.json'), /tracked/i)
  assert.throws(() => assertNotTrackedSettingsPath('.claude/settings.local.json'), /tracked/i)
})

test('assertNotTrackedSettingsPath rejects Windows-style backslash paths', () => {
  assert.throws(() => assertNotTrackedSettingsPath('C:\\repo\\.claude\\settings.json'), /tracked/i)
  assert.throws(() => assertNotTrackedSettingsPath('.claude\\settings.local.json'), /tracked/i)
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

test('resolveMainCheckoutRoot: reads the main root from `git worktree list --porcelain` output produced as-if from inside a linked worktree (main entry is always listed first, regardless of cwd)', () => {
  const porcelainFromInsideLinkedWorktree = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/.claude/worktrees/client-wiring-b1',
    'HEAD def456',
    'branch refs/heads/client-wiring-b1',
    '',
  ].join('\n')
  assert.equal(
    resolveMainCheckoutRoot({ worktreeListPorcelain: porcelainFromInsideLinkedWorktree }),
    resolve('/repo'),
  )
})

test('resolveMainCheckoutRoot: derives the main root from a --git-common-dir path (parent of the common .git dir)', () => {
  assert.equal(resolveMainCheckoutRoot({ gitCommonDir: '/repo/.git' }), resolve('/repo'))
})

test('resolveMainCheckoutRoot: throws a clear error when neither input is provided', () => {
  assert.throws(() => resolveMainCheckoutRoot({}), /gitCommonDir|worktreeListPorcelain/)
})

test('resolveMainCheckoutRoot: throws a clear error when porcelain output has no worktree entry', () => {
  assert.throws(() => resolveMainCheckoutRoot({ worktreeListPorcelain: '' }), /worktree/i)
})

test('removeStaleEntriesFromConfig: removes only the targeted project/server key, leaving siblings untouched', () => {
  const config = {
    projects: {
      '/repo/.claude/worktrees/gone': {
        mcpServers: { whiteboard: { type: 'http', url: 'http://127.0.0.1:3100/mcp' }, other: { type: 'http', url: 'x' } },
      },
      '/repo/.claude/worktrees/alive': {
        mcpServers: { whiteboard: { type: 'http', url: 'http://127.0.0.1:3200/mcp' } },
      },
    },
    someOtherTopLevelKey: 'untouched',
  }
  const result = removeStaleEntriesFromConfig(config, [{ action: 'remove', name: 'whiteboard', path: '/repo/.claude/worktrees/gone' }])

  assert.equal(result.projects['/repo/.claude/worktrees/gone'].mcpServers.whiteboard, undefined)
  assert.deepEqual(result.projects['/repo/.claude/worktrees/gone'].mcpServers.other, { type: 'http', url: 'x' })
  assert.deepEqual(result.projects['/repo/.claude/worktrees/alive'], config.projects['/repo/.claude/worktrees/alive'])
  assert.equal(result.someOtherTopLevelKey, 'untouched')
})

test('removeStaleEntriesFromConfig: does not mutate the original config object', () => {
  const config = { projects: { '/repo/wt': { mcpServers: { whiteboard: { type: 'http', url: 'x' } } } } }
  const snapshot = JSON.parse(JSON.stringify(config))
  removeStaleEntriesFromConfig(config, [{ action: 'remove', name: 'whiteboard', path: '/repo/wt' }])
  assert.deepEqual(config, snapshot)
})

test('removeStaleEntriesFromConfig: no-ops when the targeted project or server key is missing', () => {
  const config = { projects: { '/repo/wt': { mcpServers: {} } } }
  const result = removeStaleEntriesFromConfig(config, [
    { action: 'remove', name: 'whiteboard', path: '/repo/wt' },
    { action: 'remove', name: 'whiteboard', path: '/repo/nonexistent' },
  ])
  assert.deepEqual(result, config)
})

test('removeStaleEntriesFromConfig: empty actions list returns an equivalent config', () => {
  const config = { projects: { '/repo/wt': { mcpServers: { whiteboard: { type: 'http', url: 'x' } } } } }
  assert.deepEqual(removeStaleEntriesFromConfig(config, []), config)
})

test('redactBearerTokens: scrubs a "Bearer <token>" header value out of a failed-command log line', () => {
  const message = "`claude mcp add --transport http whiteboard http://127.0.0.1:3457/mcp --scope local --header 'Authorization: Bearer super-secret-token'` failed"
  const redacted = redactBearerTokens(message)
  assert.ok(!redacted.includes('super-secret-token'), 'the live token must not appear in the redacted text')
  assert.ok(redacted.includes('Bearer [redacted]'))
})

test('redactBearerTokens: scrubs every occurrence, including one echoed back in CLI stderr output', () => {
  const message = 'sent Authorization: Bearer abc123 but server replied with Authorization: Bearer abc123 (unauthorized)'
  const redacted = redactBearerTokens(message)
  assert.ok(!redacted.includes('abc123'))
  assert.equal((redacted.match(/Bearer \[redacted\]/g) ?? []).length, 2)
})

test('redactBearerTokens: leaves text with no bearer token untouched', () => {
  assert.equal(redactBearerTokens('no secrets here'), 'no secrets here')
})

test('docs-lock: the manual fallback `claude mcp add` command in development.md matches buildClaudeMcpAddArgs argv order', () => {
  const docsPath = resolve(__dirname, '../../docs/contributing/development.md')
  const docs = readFileSync(docsPath, 'utf8')
  const match = docs.match(/`claude mcp add ([^`]+)`/)
  assert.ok(match, 'expected a `claude mcp add ...` fallback command in development.md')

  const desired = { name: 'whiteboard', url: 'http://127.0.0.1:3100/mcp', authHeader: "Authorization: Bearer whiteboard-dev" }
  const expectedArgs = buildClaudeMcpAddArgs(desired).slice(2) // drop the leading "mcp add" the regex already anchors on
  const expectedFragment = expectedArgs
    .map((arg) => (arg.includes(' ') ? `'${arg}'` : arg))
    .join(' ')
    .replace('http://127.0.0.1:3100/mcp', '<port-placeholder>')

  const docsFragment = match[1]
    .replace(/http:\/\/127\.0\.0\.1:<port>\/mcp/, '<port-placeholder>')

  assert.equal(docsFragment, expectedFragment, 'docs fallback command argv order must match buildClaudeMcpAddArgs')
})
