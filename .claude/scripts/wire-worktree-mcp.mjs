#!/usr/bin/env node
// Auto-wires a git worktree's Claude Code session to its own per-worktree
// dev daemon port (see packages/mcp-server/scripts/dev/dev-port-lib.mjs),
// so opening a worktree in Claude Code never has to fall back to the
// tracked .mcp.json's broken `npx @kamiazya/whiteboard-mcp@latest` stdio
// entry or the main checkout's port-3099 URL.
//
// Mechanism: `claude mcp add --scope local` under the SAME name as the
// tracked entry ("whiteboard") writes to ~/.claude.json, keyed by this
// worktree's absolute path — that local-scope entry cleanly shadows the
// repo-tracked .mcp.json project-scope entry of the same name for every
// purpose that matters, with no name collision or guesswork for an agent
// (verified against the real CLI).
//
//   node .claude/scripts/wire-worktree-mcp.mjs [worktreePath]   (default: cwd)
//   node .claude/scripts/wire-worktree-mcp.mjs --sweep          (remove entries for deleted worktrees)
//
// All decision logic lives in wire-worktree-mcp-lib.mjs (pure, unit-tested);
// this file only does I/O: reading/writing ~/.claude.json, spawning the
// `claude` CLI, and running `git`. `main()` takes every I/O dependency as an
// injectable argument so the decision sequencing above is exercised by
// wire-worktree-mcp.test.mjs without ever touching real developer-global
// state; it only auto-runs when this file is executed directly (guarded by
// a realpath comparison, so a symlinked worktree checkout doesn't trip a
// naive string compare).
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainCheckout } from '../../packages/mcp-server/scripts/dev/dev-port-lib.mjs'
import {
  assertNotTrackedSettingsPath,
  buildClaudeMcpAddArgs,
  buildDesiredConfig,
  classifyExistingConfig,
  planStaleSweep,
  redactBearerTokens,
  removeStaleEntriesFromConfig,
  resolveMainCheckoutRoot,
  verifyPostWrite,
} from './wire-worktree-mcp-lib.mjs'

const CLAUDE_CONFIG_PATH = join(homedir(), '.claude.json')

// A freshly-created ~/.claude.json can hold MCP bearer tokens, so a brand
// new file gets a restrictive mode by default instead of inheriting
// whatever the process umask would otherwise allow.
const DEFAULT_CONFIG_MODE = 0o600

/**
 * Builds a read/write pair scoped to one config path. Kept as a factory
 * (rather than two free functions closing over a single module-level path)
 * so tests can point it at a scratch file instead of the real, developer-
 * global ~/.claude.json.
 *
 * The pair guards two things a naive read-JSON/write-JSON round trip does
 * not:
 *  - Concurrency: `writeConfig` refuses to overwrite the file if its raw
 *    contents changed since the paired `readConfig` call — a `claude mcp`
 *    invocation or another Claude Code session racing this script would
 *    otherwise have its write silently discarded.
 *  - Permissions: the temp-file-then-rename write preserves the existing
 *    file's mode (or applies a restrictive default for a new file) instead
 *    of letting the process umask decide, since this file can carry MCP
 *    credentials.
 *
 * @param {string} configPath
 */
export function createConfigIO(configPath) {
  let lastReadRawText

  function readConfig() {
    if (!existsSync(configPath)) {
      lastReadRawText = null
      return null
    }
    try {
      const raw = readFileSync(configPath, 'utf8')
      lastReadRawText = raw
      return JSON.parse(raw)
    } catch {
      // Malformed ~/.claude.json is the CLI's own concern to repair, not
      // something this script should ever try to fix or overwrite. Mark the
      // snapshot as unknown so writeConfig's concurrency guard below is
      // skipped rather than permanently blocking on unparsable content.
      lastReadRawText = undefined
      return null
    }
  }

  function writeConfig(config) {
    assertNotTrackedSettingsPath(configPath)
    if (lastReadRawText !== undefined) {
      const currentRaw = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null
      if (currentRaw !== lastReadRawText) {
        throw new Error(
          `${configPath} changed since it was last read — another process wrote to it concurrently. ` +
            'Rerun instead of overwriting that change.',
        )
      }
    }
    const previousMode = existsSync(configPath) ? statSync(configPath).mode : DEFAULT_CONFIG_MODE
    const tmpPath = `${configPath}.tmp-${process.pid}`
    writeFileSync(tmpPath, JSON.stringify(config, null, 2))
    chmodSync(tmpPath, previousMode)
    renameSync(tmpPath, configPath)
  }

  return { readConfig, writeConfig }
}

const { readConfig: defaultReadConfig, writeConfig: defaultWriteConfig } = createConfigIO(CLAUDE_CONFIG_PATH)

function defaultSpawn(cmd, args, options) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...options })
}

function defaultIsClaudeCliAvailable(spawn) {
  const result = spawn('claude', ['--version'], { stdio: 'ignore' })
  return result.error === undefined && result.status === 0
}

function readExistingEntry(config, repoRootAbsPath, name) {
  return config?.projects?.[repoRootAbsPath]?.mcpServers?.[name]
}

// Lazily resolves the MAIN checkout root from wherever this script happens
// to run (main checkout or any linked worktree) — `--git-common-dir` always
// points at the one shared `.git` directory, so its parent is the answer
// regardless of cwd. Only called for --sweep; plain wiring never needs it.
function defaultMainCheckoutRoot(cwd) {
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  }).trim()
  return resolveMainCheckoutRoot({ gitCommonDir: commonDir })
}

function defaultLiveWorktreePaths(mainCheckoutRoot) {
  const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: mainCheckoutRoot, encoding: 'utf8' })
  return raw
    .split('\n\n')
    .map((block) => block.match(/^worktree (.+)$/m)?.[1])
    .filter((path) => path !== undefined)
    .map((path) => resolve(path))
}

function wireWorktree({ worktreeRoot, env, spawn, readConfig, log, isMainCheckoutOverride, claudeCliAvailableOverride }) {
  const repoRoot = resolve(worktreeRoot)
  const mainCheckout = isMainCheckoutOverride ?? isMainCheckout(repoRoot)

  if (mainCheckout) {
    log(
      `[wire-worktree-mcp] ${repoRoot} is the main checkout — already wired via tracked .claude/settings.json (port 3099); nothing to do.`,
    )
    return
  }

  const cliAvailable = claudeCliAvailableOverride ?? defaultIsClaudeCliAvailable(spawn)
  if (!cliAvailable) {
    log(
      '[wire-worktree-mcp] the `claude` CLI is not on PATH — skipping automatic wiring. ' +
        'Wire this worktree manually once claude is installed: see docs/contributing/development.md.',
    )
    return
  }

  const desired = buildDesiredConfig({ repoRoot, env, isMainCheckout: false })
  if (desired.overrideWarning) {
    log(
      `[wire-worktree-mcp] WHITEBOARD_DEV_PORT is set in this shell but is ignored for registration — ` +
        `the override is session-scoped and would diverge from the port a fresh session's SessionStart ` +
        `hook actually starts the daemon on. Registering the path-derived port ${desired.port} instead.`,
    )
  }

  const existingConfig = readConfig()
  const existing = readExistingEntry(existingConfig, repoRoot, desired.name)
  const classification = classifyExistingConfig(existing, desired)

  if (classification.outcome === 'identical') {
    log(`[wire-worktree-mcp] "${desired.name}" already wired to ${desired.url} — nothing to do.`)
    return
  }

  if (classification.outcome === 'conflict') {
    log(
      `[wire-worktree-mcp] "${desired.name}" has a conflicting existing registration — leaving it untouched. ` +
        `${classification.reason} Remove it manually first if you want this script to (re)wire it: ` +
        `\`claude mcp remove ${desired.name} -s local\`.`,
    )
    return
  }

  // outcome === 'absent'
  assertNotTrackedSettingsPath(CLAUDE_CONFIG_PATH)
  const addArgs = buildClaudeMcpAddArgs(desired)
  const result = spawn('claude', addArgs, { cwd: repoRoot })
  if (result.status !== 0) {
    const redactedCommand = redactBearerTokens(`claude ${addArgs.join(' ')}`)
    const redactedOutput = redactBearerTokens(String(result.stderr || result.stdout || ''))
    log(`[wire-worktree-mcp] \`${redactedCommand}\` failed (exit ${result.status}): ${redactedOutput}`)
    return
  }

  const effectiveConfig = readConfig()
  const effective = readExistingEntry(effectiveConfig, repoRoot, desired.name)
  const verified = verifyPostWrite(effective, desired)
  if (verified.outcome === 'wired') {
    log(`[wire-worktree-mcp] wired "${desired.name}" -> ${desired.url}`)
  } else {
    log(
      `[wire-worktree-mcp] wrote "${desired.name}" but the post-write state does not match what we ` +
        `requested (${verified.reason}) — a concurrent writer likely raced this script. Rerun to reconcile.`,
    )
  }
}

function sweepStaleEntries({ mainCheckoutRoot, liveWorktreePaths, readConfig, writeConfig, log }) {
  const config = readConfig()
  if (!config?.projects) {
    log('[wire-worktree-mcp] no ~/.claude.json projects found — nothing to sweep.')
    return
  }

  // Every project entry under this repo's worktrees directory that still
  // carries our desired name is a candidate for the sweep — entries under
  // any other name (or another repo entirely) are out of scope. The prefix
  // must use the platform separator (not a hardcoded '/'): project keys in
  // ~/.claude.json are absolute paths in the OS's native form, so on
  // Windows join() itself already returns backslashes and a hardcoded '/'
  // would never match, silently sweeping nothing.
  const registered = Object.keys(config.projects)
    .filter((projectPath) => projectPath.startsWith(join(mainCheckoutRoot, '.claude', 'worktrees') + sep))
    .map((projectPath) => {
      const entry = config.projects[projectPath]?.mcpServers?.whiteboard
      return entry ? { name: 'whiteboard', path: resolve(projectPath) } : null
    })
    .filter((entry) => entry !== null)

  const actions = planStaleSweep(registered, liveWorktreePaths)
  if (actions.length === 0) {
    log('[wire-worktree-mcp] sweep: no stale registrations found.')
    return
  }

  assertNotTrackedSettingsPath(CLAUDE_CONFIG_PATH)
  const nextConfig = removeStaleEntriesFromConfig(config, actions)
  writeConfig(nextConfig)
  for (const action of actions) {
    log(`[wire-worktree-mcp] sweep: removed stale "${action.name}" registration for ${action.path}`)
  }
}

/**
 * @param {{
 *   argv?: string[], env?: Record<string, string | undefined>,
 *   spawn?: typeof defaultSpawn, readConfig?: typeof defaultReadConfig, writeConfig?: typeof defaultWriteConfig,
 *   log?: (msg: string) => void, isMainCheckoutOverride?: boolean, claudeCliAvailableOverride?: boolean,
 *   mainCheckoutRootOverride?: string, liveWorktreePathsOverride?: string[],
 * }} [deps]
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  spawn = defaultSpawn,
  readConfig = defaultReadConfig,
  writeConfig = defaultWriteConfig,
  log = (msg) => console.log(msg),
  isMainCheckoutOverride,
  claudeCliAvailableOverride,
  mainCheckoutRootOverride,
  liveWorktreePathsOverride,
} = {}) {
  if (argv.includes('--sweep')) {
    const cwd = process.cwd()
    const mainCheckoutRoot = mainCheckoutRootOverride ?? defaultMainCheckoutRoot(cwd)
    const liveWorktreePaths = liveWorktreePathsOverride ?? defaultLiveWorktreePaths(mainCheckoutRoot)
    sweepStaleEntries({ mainCheckoutRoot, liveWorktreePaths, readConfig, writeConfig, log })
    return
  }

  const target = argv.find((a) => !a.startsWith('--')) ?? process.cwd()
  wireWorktree({
    worktreeRoot: target,
    env,
    spawn,
    readConfig,
    log,
    isMainCheckoutOverride,
    claudeCliAvailableOverride,
  })
}

function isRunAsScript() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isRunAsScript()) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
