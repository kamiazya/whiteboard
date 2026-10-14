/**
 * A skill is instructions a later session follows literally, so a path it
 * names is a decision input, not decoration: "if you touched `<path>`, the
 * client must reconnect" classifies nothing once `<path>` has moved, and the
 * reader falls through to whichever branch is left. Every backticked
 * `packages/…` or `src/…` path in a `SKILL.md` must therefore name something
 * that exists — a `packages/…` path from the repo root, a bare `src/…` path
 * inside at least one workspace.
 *
 * A glob is checked up to its first wildcard segment: `src/server/**` holds
 * when `src/server` exists, which is the most a glob can promise before it
 * is expanded.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, workspaceDirs } from './scan-roots.js'

const SKILLS = join(REPO_ROOT, '.claude', 'skills')

const PATH_REFERENCE = /`((?:packages|src)\/[^`\s]*)`/g

/** The part of a path or glob that must exist: everything before its first wildcard segment. */
function fixedPrefix(reference: string): string {
  const segments = reference.split('/')
  const firstWild = segments.findIndex((segment) => /[*?{[]/.test(segment))
  const fixed = firstWild === -1 ? segments : segments.slice(0, firstWild)
  return fixed.filter((segment) => segment !== '').join('/')
}

function resolves(reference: string, workspaces: readonly string[]): boolean {
  const prefix = fixedPrefix(reference)
  if (reference.startsWith('packages/')) return existsSync(join(REPO_ROOT, prefix))
  return workspaces.some((dir) => existsSync(join(REPO_ROOT, dir, prefix)))
}

const references = readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS, entry.name, 'SKILL.md')))
  .flatMap((entry) => {
    const text = readFileSync(join(SKILLS, entry.name, 'SKILL.md'), 'utf-8')
    return [...text.matchAll(PATH_REFERENCE)].map((match) => ({
      skill: entry.name,
      path: match[1] as string,
    }))
  })

describe('every path a skill names exists', () => {
  const workspaces = workspaceDirs()

  it('reads real references from more than one skill', () => {
    expect(references.length).toBeGreaterThan(20)
    expect(new Set(references.map((ref) => ref.skill)).size).toBeGreaterThan(4)
    expect(references.map((ref) => ref.path)).toContain(
      'packages/mcp-server/scripts/smoke/mcp-e2e-smoke.mjs',
    )
  })

  it('refuses a glob whose fixed prefix is gone, and keeps one whose prefix is there', () => {
    expect(fixedPrefix('packages/*/src/**')).toBe('packages')
    expect(fixedPrefix('src/server/')).toBe('src/server')
    expect(resolves('src/server/mcp/tools/**', workspaces)).toBe(false)
    expect(resolves('packages/mcp-server/src/server/mcp/tools/**', workspaces)).toBe(false)
    expect(resolves('packages/server-core/src/tools/**', workspaces)).toBe(true)
    expect(resolves('src/server/mcp/**', workspaces)).toBe(true)
  })

  it('names no path that does not exist', () => {
    const missing = references
      .filter((ref) => !resolves(ref.path, workspaces))
      .map((ref) => `${ref.skill}: ${ref.path}`)
    expect(missing).toEqual([])
  })
})
