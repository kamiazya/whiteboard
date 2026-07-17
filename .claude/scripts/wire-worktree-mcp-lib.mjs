#!/usr/bin/env node
// Pure planning logic for auto-wiring a worktree's Claude Code session to
// its per-worktree dev daemon port (see dev-port-lib.mjs). Kept free of any
// `claude` CLI invocation or filesystem/network I/O so the classify/plan
// decisions are unit-testable without ever touching the real, developer-
// global ~/.claude.json.
import { dirname, resolve } from 'node:path'
import { deriveDevPort } from '../../packages/mcp-server/scripts/dev/dev-port-lib.mjs'
import { resolveDevBearerToken } from '../../packages/mcp-server/scripts/dev/ensure-http-dev-daemon-lib.mjs'

/** @param {number} port */
export function buildMcpUrl(port) {
  return `http://127.0.0.1:${port}/mcp`
}

/**
 * Derives the desired registration for a worktree. The port always comes
 * from the worktree's path (via deriveDevPort with env stripped of
 * WHITEBOARD_DEV_PORT) — never from an active override — because a
 * baked-in overridden URL would diverge from whatever port a fresh
 * session's SessionStart hook (which sees no persistent override) actually
 * starts the daemon on. `overrideWarning` signals that divergence risk to
 * the caller so it can surface a warning instead of silently registering
 * a possibly-stale port.
 *
 * Registers under the tracked entry's own name ("whiteboard") by default,
 * not a distinct one: a `--scope local` registration cleanly shadows the
 * repo-tracked `.mcp.json` project-scope entry of the same name — verified
 * against the real CLI — so an agent in this worktree only ever sees one
 * "whiteboard" server, not a working one plus a permanently-broken decoy
 * under a different name.
 *
 * @param {{ repoRoot: string, env?: Record<string, string | undefined>, isMainCheckout?: boolean, name?: string }} args
 */
export function buildDesiredConfig({ repoRoot, env = {}, isMainCheckout = false, name = 'whiteboard' }) {
  if (isMainCheckout) {
    throw new Error('refusing to build a wiring config for the main checkout — it is wired via tracked settings.json to port 3099')
  }
  const envWithoutOverride = { ...env }
  delete envWithoutOverride.WHITEBOARD_DEV_PORT
  const port = deriveDevPort({ repoRoot, isMainCheckout: false, env: envWithoutOverride })
  const token = resolveDevBearerToken(env)
  return {
    name,
    port,
    url: buildMcpUrl(port),
    authHeader: `Authorization: Bearer ${token}`,
    overrideWarning: env.WHITEBOARD_DEV_PORT !== undefined,
  }
}

/**
 * Builds the argv for `claude mcp add`. `<name>` and `<url>` must come
 * right after `--transport http` — commander (the CLI's arg parser) reports
 * "missing required argument 'name'" if they're placed after `--scope`/
 * `--header` instead, confirmed against the real CLI.
 *
 * @param {{ name: string, url: string, authHeader: string }} desired
 */
export function buildClaudeMcpAddArgs(desired) {
  return ['mcp', 'add', '--transport', 'http', desired.name, desired.url, '--scope', 'local', '--header', desired.authHeader]
}

// Matches the literal "Bearer <token>" text produced by buildDesiredConfig's
// authHeader (and echoed back verbatim by a failing `claude mcp add`'s own
// argv/stderr/stdout) so it can be scrubbed before anything reaches a log
// sink — a failed CLI invocation is exactly the kind of unexpected path that
// otherwise prints the live WHITEBOARD_TOKEN in the clear.
const BEARER_TOKEN_PATTERN = /Bearer\s+\S+/g

/**
 * Redacts any "Bearer <token>" occurrence in free-form text (CLI argv joined
 * for a log line, or a spawned process's stdout/stderr) before it is logged.
 *
 * @param {string} text
 */
export function redactBearerTokens(text) {
  if (typeof text !== 'string') return text
  return text.replace(BEARER_TOKEN_PATTERN, 'Bearer [redacted]')
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
 * @param {{ url: string, authHeader: string }} desired
 */
export function classifyExistingConfig(existing, desired) {
  if (existing === undefined) {
    return { outcome: 'absent' }
  }
  if (!isPlainObject(existing)) {
    return { outcome: 'conflict', reason: `existing registration has an unrecognized shape: ${JSON.stringify(existing)}` }
  }
  if (existing.type !== 'http') {
    return { outcome: 'conflict', reason: `existing registration uses transport ${JSON.stringify(existing.type)}, expected 'http'` }
  }
  if (typeof existing.url !== 'string' || existing.url !== desired.url) {
    return { outcome: 'conflict', reason: `existing registration URL ${JSON.stringify(existing.url)} does not match desired ${JSON.stringify(desired.url)}` }
  }
  const [headerName, headerValue] = desired.authHeader.split(': ')
  const existingHeaderValue = isPlainObject(existing.headers) ? existing.headers[headerName] : undefined
  if (existingHeaderValue !== headerValue) {
    return { outcome: 'conflict', reason: `existing registration is missing or has a different ${headerName} header` }
  }
  const extraKeys = Object.keys(existing).filter((key) => !['type', 'url', 'headers'].includes(key))
  if (extraKeys.length > 0) {
    return { outcome: 'conflict', reason: `existing registration has unexpected extra fields: ${extraKeys.join(', ')}` }
  }
  const extraHeaderKeys = Object.keys(existing.headers ?? {}).filter((key) => key !== headerName)
  if (extraHeaderKeys.length > 0) {
    return { outcome: 'conflict', reason: `existing registration has unexpected extra headers: ${extraHeaderKeys.join(', ')}` }
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
 * @param {{ url: string, authHeader: string }} desired
 */
export function verifyPostWrite(effective, desired) {
  const classification = classifyExistingConfig(effective, desired)
  if (classification.outcome === 'identical') {
    return { outcome: 'wired' }
  }
  return { outcome: 'post-write-mismatch', reason: classification.reason ?? 'post-write config does not match desired state' }
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
 * Given registered worktree-scoped entries and the set of live worktree
 * paths (from `git worktree list`), classifies entries whose directory no
 * longer exists as stale and emits removal actions. Live entries are left
 * untouched.
 *
 * @param {Array<{ name: string, path: string }>} registered
 * @param {string[]} liveWorktreePaths
 */
export function planStaleSweep(registered, liveWorktreePaths) {
  const live = new Set(liveWorktreePaths)
  return registered.filter((entry) => !live.has(entry.path)).map((entry) => ({ action: 'remove', name: entry.name, path: entry.path }))
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
      throw new Error('could not find a `worktree <path>` entry in `git worktree list --porcelain` output')
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
 * @param {Array<{ action: 'remove', name: string, path: string }>} actions
 */
export function removeStaleEntriesFromConfig(config, actions) {
  const projects = { ...(config.projects ?? {}) }
  for (const action of actions) {
    const project = projects[action.path]
    if (!project?.mcpServers?.[action.name]) continue
    const mcpServers = { ...project.mcpServers }
    delete mcpServers[action.name]
    projects[action.path] = { ...project, mcpServers }
  }
  return { ...config, projects }
}
