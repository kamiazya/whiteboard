#!/usr/bin/env node
// Pure planning logic for auto-wiring a worktree's Claude Code session to
// the dev daemon, through a checkout's stdio proxy. Kept free of any
// `claude` CLI invocation or filesystem/network I/O so the classify/plan
// decisions are unit-testable without ever touching the real, developer-
// global ~/.claude.json.
import { dirname, join, resolve, sep } from 'node:path'

const PROXY_SEGMENTS = ['packages', 'mcp-server', 'scripts', 'dev', 'mcp-http-stdio-proxy.mjs']

/**
 * Derives the desired registration for a checkout: that checkout's own
 * stdio proxy, which reaches the daemon over the socket named in its own
 * data dir and sends the bearer token itself — so nothing in the
 * registration names a port or carries a secret.
 *
 * Registers under the tracked entry's own name ("whiteboard") by default,
 * not a distinct one: a `--scope local` registration cleanly shadows the
 * repo-tracked `.mcp.json` project-scope entry of the same name — verified
 * against the real CLI — so an agent in this worktree only ever sees one
 * "whiteboard" server, not a working one plus a permanently-broken decoy
 * under a different name.
 *
 * @param {{ repoRoot: string, isMainCheckout?: boolean, name?: string }} args
 */
export function buildDesiredConfig({ repoRoot, isMainCheckout = false, name = 'whiteboard' }) {
  if (isMainCheckout) {
    throw new Error(
      'refusing to build a wiring config for the main checkout — it is registered once by hand (see .claude/settings.json)',
    )
  }
  return {
    name,
    command: 'node',
    args: [join(repoRoot, ...PROXY_SEGMENTS)],
  }
}

/**
 * The shell command that registers a checkout's stdio proxy under the tracked entry's name —
 * what CONTRIBUTING.md's first-clone step spells out, derived from the same builders the wiring
 * uses so the two cannot drift. The path is double-quoted because a checkout path may hold spaces.
 *
 * @param {string} checkoutRoot
 */
export function buildReRegisterCommand(checkoutRoot) {
  const addArgs = buildClaudeMcpAddArgs(buildDesiredConfig({ repoRoot: checkoutRoot }))
  const split = addArgs.indexOf('--') + 1
  const serverLine = addArgs.slice(split).map((part, i) => (i === 0 ? part : JSON.stringify(part)))
  return `claude ${[...addArgs.slice(0, split), ...serverLine].join(' ')}`
}

/**
 * The checkout a stdio-proxy registration was written for, or null when the entry is not one of
 * this script's registrations (an `npx` entry, an http entry, a proxy path of another layout).
 * Only those are ever candidates for the sweep: anything else under the main checkout's key was
 * put there by hand and is not this script's to remove.
 *
 * @param {unknown} entry
 */
export function stdioProxyRootOf(entry) {
  if (
    !isPlainObject(entry) ||
    entry.type !== 'stdio' ||
    !Array.isArray(entry.args) ||
    entry.args.length !== 1
  )
    return null
  const script = resolve(String(entry.args[0]))
  const suffix = join(...PROXY_SEGMENTS)
  return script.endsWith(sep + suffix) ? script.slice(0, script.length - suffix.length - 1) : null
}

/**
 * Builds the argv for `claude mcp add`: everything after `--` is the stdio
 * server's own command line.
 *
 * @param {{ name: string, command: string, args: string[] }} desired
 */
export function buildClaudeMcpAddArgs(desired) {
  return [
    'mcp',
    'add',
    '--scope',
    'local',
    '--transport',
    'stdio',
    desired.name,
    '--',
    desired.command,
    ...desired.args,
  ]
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Compares an existing registration (as read back from `claude mcp get`,
 * shape owned by the Claude Code CLI and treated defensively here) against
 * the desired one. Any shape the caller doesn't fully recognize maps to
 * 'conflict' rather than throwing or silently treating it as a match —
 * unknown/partial/malformed input is never assumed identical.
 *
 * @param {unknown} existing
 * @param {{ command: string, args: string[] }} desired
 */
export function classifyExistingConfig(existing, desired) {
  if (existing === undefined) {
    return { outcome: 'absent' }
  }
  if (!isPlainObject(existing)) {
    return {
      outcome: 'conflict',
      reason: `existing registration has an unrecognized shape: ${JSON.stringify(existing)}`,
    }
  }
  if (existing.type !== 'stdio') {
    return {
      outcome: 'conflict',
      reason: `existing registration uses transport ${JSON.stringify(existing.type)}, expected 'stdio'`,
    }
  }
  const desiredLine = [desired.command, ...desired.args]
  const existingLine = Array.isArray(existing.args) ? [existing.command, ...existing.args] : null
  if (existingLine === null || JSON.stringify(existingLine) !== JSON.stringify(desiredLine)) {
    return {
      outcome: 'conflict',
      reason: `existing registration runs ${JSON.stringify(existingLine ?? existing.command)}, expected ${JSON.stringify(desiredLine)}`,
    }
  }
  // An `env` block could carry anything, including a secret, so none of it
  // is reported.
  if (
    existing.env !== undefined &&
    (!isPlainObject(existing.env) || Object.keys(existing.env).length > 0)
  ) {
    return { outcome: 'conflict', reason: 'existing registration sets environment variables' }
  }
  const extraKeys = Object.keys(existing).filter(
    (key) => !['type', 'command', 'args', 'env'].includes(key),
  )
  if (extraKeys.length > 0) {
    return {
      outcome: 'conflict',
      reason: `existing registration has unexpected extra fields: ${extraKeys.join(', ')}`,
    }
  }
  return { outcome: 'identical' }
}

/**
 * Re-reads the effective post-write config and compares it to what was
 * requested. A mismatch means a concurrent writer raced this script between
 * the classify step and the write — the safe response is to report it, not
 * to retry-overwrite.
 *
 * @param {unknown} effective
 * @param {{ command: string, args: string[] }} desired
 */
export function verifyPostWrite(effective, desired) {
  const classification = classifyExistingConfig(effective, desired)
  if (classification.outcome === 'identical') {
    return { outcome: 'wired' }
  }
  return {
    outcome: 'post-write-mismatch',
    reason: classification.reason ?? 'post-write config does not match desired state',
  }
}

/**
 * Any write action must never target the repo's tracked .claude/ config
 * (settings.json and friends) — worktree wiring is scoped to per-worktree
 * local state only. Throws rather than returning a boolean so a caller
 * cannot accidentally ignore the result.
 *
 * @param {string} targetPath
 */
export function assertNotTrackedSettingsPath(targetPath) {
  const normalized = targetPath.replace(/\\/g, '/')
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(normalized)) {
    throw new Error(`refusing to write to tracked settings path: ${targetPath}`)
  }
}

/**
 * Given registered entries and the set of live worktree paths (from `git
 * worktree list`, which includes the main checkout), classifies entries whose
 * directory no longer exists as stale and emits removal actions. Live entries
 * are left untouched.
 *
 * `path` is the checkout the entry points at; `projectKey` is the
 * ~/.claude.json project it is stored under, which is only the same thing for
 * an entry keyed by its own worktree. `claude mcp add --scope local` keys by
 * the MAIN checkout, so an entry for a worktree usually sits under that key.
 *
 * @param {Array<{ name: string, path: string, projectKey?: string }>} registered
 * @param {string[]} liveWorktreePaths
 */
export function planStaleSweep(registered, liveWorktreePaths) {
  const live = new Set(liveWorktreePaths)
  return registered
    .filter((entry) => !live.has(entry.path))
    .map((entry) => ({
      action: 'remove',
      name: entry.name,
      path: entry.path,
      ...(entry.projectKey === undefined ? {} : { projectKey: entry.projectKey }),
    }))
}

/**
 * Resolves the MAIN checkout root regardless of which worktree the caller
 * is running from. `git rev-parse --show-toplevel` answers "top of THIS
 * worktree", which is wrong for `--sweep` when invoked from inside a linked
 * worktree — it needs the main repo root to know which `.claude/worktrees/`
 * prefix its registered entries live under. Accepts either the porcelain
 * output of `git worktree list --porcelain` (main entry is always listed
 * first, independent of cwd) or a `--git-common-dir` path (the shared
 * `.git` directory every worktree — main or linked — points at; its parent
 * is always the main checkout root).
 *
 * @param {{ worktreeListPorcelain?: string, gitCommonDir?: string }} args
 */
export function resolveMainCheckoutRoot({ worktreeListPorcelain, gitCommonDir } = {}) {
  if (gitCommonDir !== undefined) {
    return resolve(dirname(gitCommonDir))
  }
  if (worktreeListPorcelain !== undefined) {
    const match = worktreeListPorcelain.match(/^worktree (.+)$/m)
    if (!match) {
      throw new Error(
        'could not find a `worktree <path>` entry in `git worktree list --porcelain` output',
      )
    }
    return resolve(match[1])
  }
  throw new Error('resolveMainCheckoutRoot requires either gitCommonDir or worktreeListPorcelain')
}

/**
 * Returns a NEW ~/.claude.json config with only the targeted stale entries
 * removed. Spawning `claude mcp remove` with cwd set to an already-deleted
 * worktree path fails (ENOENT) and removes nothing, so the sweep edits the
 * config directly instead — this keeps the removal itself pure/testable
 * and leaves the atomic file write to the thin I/O entry.
 *
 * @param {{ projects?: Record<string, { mcpServers?: Record<string, unknown> }> }} config
 * @param {Array<{ action: 'remove', name: string, path: string, projectKey?: string }>} actions
 */
export function removeStaleEntriesFromConfig(config, actions) {
  const projects = { ...(config.projects ?? {}) }
  for (const action of actions) {
    const key = action.projectKey ?? action.path
    const project = projects[key]
    if (!project?.mcpServers?.[action.name]) continue
    const mcpServers = { ...project.mcpServers }
    delete mcpServers[action.name]
    projects[key] = { ...project, mcpServers }
  }
  return { ...config, projects }
}

/**
 * True when this checkout is a LINKED worktree whose CLI-resolved project entry is the main
 * checkout's, and that entry already holds `name`.
 *
 * `claude mcp add --scope local` keys its write by the project the CLI resolves, which for a
 * linked worktree is the main checkout — there is only ever one project key per repository in
 * ~/.claude.json. So an add attempted from a worktree lands on the main entry and fails with
 * "already exists". The add cannot succeed, and retrying it each time a worktree is created just
 * prints a failed command line. Detect it first and explain instead.
 *
 * @param {{ config: unknown, repoRoot: string, mainRoot: string, name: string }} input
 */
export function resolvesToAnotherProjectEntry({ config, repoRoot, mainRoot, name }) {
  if (repoRoot === mainRoot) return false
  const projects = config && typeof config === 'object' ? config.projects : null
  if (!projects || typeof projects !== 'object') return false
  return Boolean(projects[mainRoot]?.mcpServers?.[name])
}
