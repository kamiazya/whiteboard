#!/usr/bin/env node
// Pure planning logic for auto-wiring a worktree's Claude Code session to
// its per-worktree dev daemon port (see dev-port-lib.mjs). Kept free of any
// `claude` CLI invocation or filesystem/network I/O so the classify/plan
// decisions are unit-testable without ever touching the real, developer-
// global ~/.claude.json.
import { deriveDevPort } from '../../packages/mcp-server/scripts/dev/dev-port-lib.mjs'

const AUTH_HEADER = 'Authorization: Bearer whiteboard-dev'

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
 * @param {{ repoRoot: string, env?: Record<string, string | undefined>, isMainCheckout?: boolean, name?: string }} args
 */
export function buildDesiredConfig({ repoRoot, env = {}, isMainCheckout = false, name = 'whiteboard-wt' }) {
  if (isMainCheckout) {
    throw new Error('refusing to build a wiring config for the main checkout — it is wired via tracked settings.json to port 3099')
  }
  const envWithoutOverride = { ...env }
  delete envWithoutOverride.WHITEBOARD_DEV_PORT
  const port = deriveDevPort({ repoRoot, isMainCheckout: false, env: envWithoutOverride })
  return {
    name,
    port,
    url: buildMcpUrl(port),
    authHeader: AUTH_HEADER,
    overrideWarning: env.WHITEBOARD_DEV_PORT !== undefined,
  }
}

/** @param {{ name: string, url: string, authHeader: string }} desired */
export function buildClaudeMcpAddArgs(desired) {
  return ['mcp', 'add', '--transport', 'http', '--scope', 'local', '--header', desired.authHeader, desired.name, desired.url]
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
  if (/\/\.claude\/settings(\.local)?\.json$/.test(normalized)) {
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
