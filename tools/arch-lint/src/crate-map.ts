import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './scan-roots.js'

/** The crate half of the architecture map, read by `cargo xtask arch-map`. */
export const CRATE_MAP_PATH = 'crates/architecture-map.json'

export interface CrateEntry {
  readonly name: string
  readonly path: string
  readonly status: 'present' | 'planned'
  readonly allowedInternalDeps: readonly string[]
  readonly absorbs: readonly string[]
}

function fail(what: string): never {
  throw new Error(`${CRATE_MAP_PATH}: ${what}`)
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

/**
 * The fields of each crate entry these guards read, checked as they are read.
 *
 * Deliberately not a Zod schema: the full contract of this file is the serde
 * struct in `crates/xtask/src/arch_map.rs`, which `pnpm rust:check` parses it
 * through and which refuses an unknown field. A second complete schema here
 * would be a parallel copy of that one; what this reads is the subset a TS
 * guard needs, and a file that has drifted from it throws naming the field
 * rather than answering with `undefined`.
 */
export function parseCrateMap(text: string): CrateEntry[] {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) fail('not an object')
  const crates = (parsed as { crates?: unknown }).crates
  if (typeof crates !== 'object' || crates === null) fail('no `crates` object')
  return Object.entries(crates).map(([name, raw]) => {
    const entry = raw as Record<string, unknown>
    const { path, status, allowedInternalDeps, absorbs } = entry
    if (typeof path !== 'string') fail(`${name}: \`path\` is not a string`)
    if (status !== 'present' && status !== 'planned') fail(`${name}: unknown \`status\``)
    if (!isStringArray(allowedInternalDeps)) fail(`${name}: \`allowedInternalDeps\``)
    if (!isStringArray(absorbs)) fail(`${name}: \`absorbs\``)
    return { name, path, status, allowedInternalDeps, absorbs }
  })
}

export function readCrateMap(repoRoot: string = REPO_ROOT): CrateEntry[] {
  return parseCrateMap(readFileSync(join(repoRoot, CRATE_MAP_PATH), 'utf8'))
}
