#!/usr/bin/env node

// Regression coverage for wire-worktree-mcp-lib.mjs's pure planning logic:
// registration/argv construction, existing-config classification, the settings.json
// write-guard, and the stale-registration sweep. No real ~/.claude.json or
// `claude` CLI invocation happens here — that stays a manual verification
// step (see docs/contributing/development.md) precisely because this repo's
// dev-flow forbids CI from mutating developer-global state.
//
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertNotTrackedSettingsPath,
  buildClaudeMcpAddArgs,
  buildDesiredConfig,
  buildReRegisterCommand,
  classifyExistingConfig,
  planStaleSweep,
  removeStaleEntriesFromConfig,
  resolveMainCheckoutRoot,
  stdioProxyRootOf,
  verifyPostWrite,
} from './wire-worktree-mcp-lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SERVER_NAME = 'whiteboard-wt'

const PROXY = '/repo/wt-a/packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs'
const DESIRED = { name: SERVER_NAME, command: 'node', args: [PROXY] }
const IDENTICAL = { type: 'stdio', command: 'node', args: [PROXY], env: {} }

test("buildDesiredConfig registers the worktree's own stdio proxy, naming no port and carrying no token", () => {
  const desired = buildDesiredConfig({ repoRoot: '/repo/wt-a' })
  assert.deepEqual(desired, { name: 'whiteboard', command: 'node', args: [PROXY] })
})

test('buildDesiredConfig defaults to the tracked entry\'s own name ("whiteboard"), not a distinct name — verified against the real CLI: a local-scope registration under the SAME name cleanly shadows the tracked project-scope .mcp.json entry, so an agent never has to choose between two visibly different whiteboard-ish MCP servers', () => {
  const desired = buildDesiredConfig({ repoRoot: '/repo/wt-a' })
  assert.equal(desired.name, 'whiteboard')
})

test('buildDesiredConfig refuses to build a config for the main checkout', () => {
  assert.throws(
    () => buildDesiredConfig({ repoRoot: '/repo', isMainCheckout: true }),
    /main checkout/i,
  )
})

test('buildClaudeMcpAddArgs produces the argv for a stdio `claude mcp add`: the server command line follows `--`', () => {
  assert.deepEqual(buildClaudeMcpAddArgs(DESIRED), [
    'mcp',
    'add',
    '--scope',
    'local',
    '--transport',
    'stdio',
    SERVER_NAME,
    '--',
    'node',
    PROXY,
  ])
})

test('classifyExistingConfig: absent entry', () => {
  assert.equal(classifyExistingConfig(undefined, DESIRED).outcome, 'absent')
})

test('classifyExistingConfig: identical entry is a no-op, with or without an empty env', () => {
  assert.equal(classifyExistingConfig(IDENTICAL, DESIRED).outcome, 'identical')
  const { env: _env, ...withoutEnv } = IDENTICAL
  assert.equal(classifyExistingConfig(withoutEnv, DESIRED).outcome, 'identical')
})

test('classifyExistingConfig: never treats a differing entry as identical', () => {
  const cases = [
    { type: 'http', url: 'http://127.0.0.1:3457/mcp', headers: {} }, // the old port-based registration
    { ...IDENTICAL, command: 'npx' }, // different command
    { ...IDENTICAL, args: ['/repo/main/packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs'] }, // another checkout's proxy
    { ...IDENTICAL, args: [PROXY, '--extra'] }, // extra argument
    { ...IDENTICAL, args: 'not-an-array' },
    { ...IDENTICAL, env: { WHITEBOARD_TOKEN: 'x' } }, // env set
    { ...IDENTICAL, extra: 'field' }, // extra unknown field
  ]
  for (const existing of cases) {
    const result = classifyExistingConfig(existing, DESIRED)
    assert.equal(result.outcome, 'conflict', `expected conflict for ${JSON.stringify(existing)}`)
    assert.ok(result.reason && result.reason.length > 0, 'conflict must carry an actionable reason')
  }
})

test('classifyExistingConfig: a conflicting registration never echoes its URL, headers or env values', () => {
  const secrets = [
    {
      type: 'http',
      url: 'http://user:hunter2@127.0.0.1:9999/mcp?token=super-secret',
      headers: { Authorization: 'Bearer super-secret' },
    },
    { ...IDENTICAL, env: { WHITEBOARD_TOKEN: 'super-secret' } },
  ]
  for (const existing of secrets) {
    const { reason } = classifyExistingConfig(existing, DESIRED)
    assert.ok(!reason.includes('hunter2') && !reason.includes('super-secret'), reason)
  }
})

test('classifyExistingConfig: defensive against malformed/unknown shapes, never throws', () => {
  const malformed = [null, 'not-an-object', 42, {}, { command: 123 }, { type: 'stdio' }]
  for (const existing of malformed) {
    const result = classifyExistingConfig(existing, DESIRED)
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
  assert.equal(verifyPostWrite(IDENTICAL, DESIRED).outcome, 'wired')
})

test('verifyPostWrite: divergent post-state (concurrent writer) reports post-write-mismatch, no overwrite', () => {
  const result = verifyPostWrite({ ...IDENTICAL, args: ['/elsewhere.mjs'] }, DESIRED)
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
  assert.deepEqual(actions, [
    { action: 'remove', name: 'whiteboard-wt', path: '/repo/.claude/worktrees/gone' },
  ])
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
        mcpServers: {
          whiteboard: { type: 'http', url: 'http://127.0.0.1:3100/mcp' },
          other: { type: 'http', url: 'x' },
        },
      },
      '/repo/.claude/worktrees/alive': {
        mcpServers: { whiteboard: { type: 'http', url: 'http://127.0.0.1:3200/mcp' } },
      },
    },
    someOtherTopLevelKey: 'untouched',
  }
  const result = removeStaleEntriesFromConfig(config, [
    { action: 'remove', name: 'whiteboard', path: '/repo/.claude/worktrees/gone' },
  ])

  assert.equal(result.projects['/repo/.claude/worktrees/gone'].mcpServers.whiteboard, undefined)
  assert.deepEqual(result.projects['/repo/.claude/worktrees/gone'].mcpServers.other, {
    type: 'http',
    url: 'x',
  })
  assert.deepEqual(
    result.projects['/repo/.claude/worktrees/alive'],
    config.projects['/repo/.claude/worktrees/alive'],
  )
  assert.equal(result.someOtherTopLevelKey, 'untouched')
})

test('removeStaleEntriesFromConfig: does not mutate the original config object', () => {
  const config = {
    projects: { '/repo/wt': { mcpServers: { whiteboard: { type: 'http', url: 'x' } } } },
  }
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
  const config = {
    projects: { '/repo/wt': { mcpServers: { whiteboard: { type: 'http', url: 'x' } } } },
  }
  assert.deepEqual(removeStaleEntriesFromConfig(config, []), config)
})

test('docs-lock: the manual fallback `claude mcp add` command in development.md matches buildClaudeMcpAddArgs argv order', () => {
  const docsPath = resolve(__dirname, '../../docs/contributing/development.md')
  const docs = readFileSync(docsPath, 'utf8')
  const match = docs.match(/`claude mcp add ([^`]+)`/)
  assert.ok(match, 'expected a `claude mcp add ...` fallback command in development.md')

  const desired = buildDesiredConfig({ repoRoot: '<worktree>' })
  const expectedFragment = buildClaudeMcpAddArgs(desired)
    .slice(2) // drop the leading "mcp add" the regex already anchors on
    .join(' ')
  const docsFragment = match[1]

  assert.equal(
    docsFragment,
    expectedFragment,
    'docs fallback command argv order must match buildClaudeMcpAddArgs',
  )
})

// --- linked-worktree project-key collision ---
import { resolvesToAnotherProjectEntry } from './wire-worktree-mcp-lib.mjs'

// Observed on every `new-worktree.mjs` run: the script reads ~/.claude.json under the WORKTREE
// path, finds nothing, and calls `claude mcp add --scope local` — which fails with "MCP server
// whiteboard already exists in local config". ~/.claude.json holds exactly one project key for
// this repo (the main checkout), so the CLI resolves a linked worktree to the main project and
// collides with the entry already there. The add can never succeed; attempting it just prints a
// failed command on every worktree creation.
test('a linked worktree whose main checkout already holds the entry is reported, not retried', () => {
  const config = { projects: { '/repo': { mcpServers: { whiteboard: { type: 'http' } } } } }
  assert.equal(
    resolvesToAnotherProjectEntry({
      config,
      repoRoot: '/repo/.claude/worktrees/x',
      mainRoot: '/repo',
      name: 'whiteboard',
    }),
    true,
  )
})

test('the main checkout itself is never treated as a collision', () => {
  const config = { projects: { '/repo': { mcpServers: { whiteboard: {} } } } }
  assert.equal(
    resolvesToAnotherProjectEntry({
      config,
      repoRoot: '/repo',
      mainRoot: '/repo',
      name: 'whiteboard',
    }),
    false,
  )
})

test('a worktree is not a collision when the main checkout has no such entry', () => {
  const config = { projects: { '/repo': { mcpServers: {} } } }
  assert.equal(
    resolvesToAnotherProjectEntry({
      config,
      repoRoot: '/repo/.claude/worktrees/x',
      mainRoot: '/repo',
      name: 'whiteboard',
    }),
    false,
  )
})

test('a missing or malformed config is not a collision', () => {
  for (const config of [null, undefined, {}, { projects: null }]) {
    assert.equal(
      resolvesToAnotherProjectEntry({
        config,
        repoRoot: '/repo/wt',
        mainRoot: '/repo',
        name: 'whiteboard',
      }),
      false,
    )
  }
})

test('stdioProxyRootOf: names the checkout a stdio-proxy registration was written for, and nothing else', () => {
  assert.equal(stdioProxyRootOf(IDENTICAL), resolve('/repo/wt-a'))
  assert.equal(
    stdioProxyRootOf({ type: 'stdio', command: 'npx', args: ['@kamiazya/whiteboard-mcp@latest'] }),
    null,
  )
  assert.equal(stdioProxyRootOf({ type: 'http', url: 'http://127.0.0.1:1/mcp' }), null)
  assert.equal(
    stdioProxyRootOf({ type: 'stdio', command: 'node', args: ['/repo/other.mjs'] }),
    null,
  )
  assert.equal(stdioProxyRootOf(undefined), null)
})

test('planStaleSweep + removeStaleEntriesFromConfig: an entry stored under another project key is removed from that key', () => {
  const config = {
    projects: {
      '/repo': { mcpServers: { whiteboard: { type: 'stdio' }, keep: { type: 'http' } } },
    },
  }
  const actions = planStaleSweep(
    [{ name: 'whiteboard', path: '/repo/.claude/worktrees/gone', projectKey: '/repo' }],
    ['/repo'],
  )
  assert.deepEqual(actions, [
    {
      action: 'remove',
      name: 'whiteboard',
      path: '/repo/.claude/worktrees/gone',
      projectKey: '/repo',
    },
  ])
  const result = removeStaleEntriesFromConfig(config, actions)
  assert.equal(result.projects['/repo'].mcpServers.whiteboard, undefined)
  assert.deepEqual(result.projects['/repo'].mcpServers.keep, { type: 'http' })
})

test('buildReRegisterCommand is the CONTRIBUTING first-clone registration, with the proxy path quoted', () => {
  assert.equal(
    buildReRegisterCommand('/my repo'),
    'claude mcp add --scope local --transport stdio whiteboard -- node "/my repo/packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs"',
  )
})

// --- a main slot naming a proxy that no longer exists ---
import { danglingMainRegistration } from './wire-worktree-mcp-lib.mjs'

test('danglingMainRegistration: only this script’s proxy registration, naming a missing script, is dangling', () => {
  const mainRoot = resolve('/repo')
  const goneScript = resolve(
    '/repo/.claude/worktrees/gone/packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs',
  )
  const proxy = { type: 'stdio', command: 'node', args: [goneScript] }
  const withEntry = (entry) => ({ projects: { [mainRoot]: { mcpServers: { whiteboard: entry } } } })

  const dangling = danglingMainRegistration({
    config: withEntry(proxy),
    mainRoot,
    pathExists: () => false,
  })
  assert.equal(dangling?.script, goneScript)

  assert.equal(
    danglingMainRegistration({ config: withEntry(proxy), mainRoot, pathExists: () => true }),
    null,
  )
  // Not this script's registration: put there by hand, so not this check's to judge.
  const npx = { type: 'stdio', command: 'npx', args: ['@kamiazya/whiteboard-mcp@latest'] }
  for (const config of [withEntry(npx), withEntry(undefined), { projects: {} }, null, {}]) {
    assert.equal(danglingMainRegistration({ config, mainRoot, pathExists: () => false }), null)
  }
})
