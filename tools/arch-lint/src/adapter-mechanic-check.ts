import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { walk } from './scan-roots.js'

/**
 * ADR-0018's invariant, made mechanical: an ADAPTER may not reach a
 * MECHANIC directly.
 *
 * An adapter is an HTTP route or an MCP tool registration — it translates a
 * transport into an operation and back. A mechanic is how this composition
 * root stores, caches, locks, schedules or sweeps. When an adapter imports
 * one, the operation it is performing has nowhere to live except inside the
 * adapter, and the next surface that needs the same operation has to write
 * it again. Every divergence ADR-0018 records began that way.
 *
 * The composition root's own wiring (`di/`, `app.ts`, `http-server.ts`) is
 * NOT an adapter and is deliberately out of scope: knowing the mechanics is
 * exactly its job.
 */
const ADAPTER_DIRS = ['routes', 'mcp'] as const

// A `_test-*` helper is scaffolding a test builds an app from, not a route a
// request reaches, so what it imports says nothing about an adapter.
function isAdapterSource(file: string): boolean {
  return file.endsWith('.ts') && !file.endsWith('.test.ts') && !/(^|[\\/])_test-/.test(file)
}

/**
 * Where a mechanic lives, and how its edge is spelled.
 *
 * `store/` holds most of them and is named by its path beneath it, unprefixed,
 * which is how the allowlist has always read. The others are the same kind of
 * thing kept elsewhere: a `*-store` under `security/` (people, sessions, keys
 * and invitations are rows in the keeper's database), the daemon's own
 * housekeeping under `daemon/`, and the tenant data layout that places every
 * file on disk. They are prefixed with their directory so `security/x-store`
 * cannot be read as a same-named `store/` module.
 *
 * What the others under `security/` and `tenant/` hold — bearer parsing,
 * credential resolution, the tenant id — is policy or a value an adapter is
 * entitled to read, and is deliberately not matched.
 */
const MECHANIC_SPECIFIERS: readonly { readonly pattern: RegExp; readonly prefix: string }[] = [
  { pattern: /from '[^']*store\/([a-z0-9-]+(?:\/[a-z0-9-]+)*)\.js'/g, prefix: '' },
  { pattern: /from '[^']*security\/([a-z0-9-]+-store)\.js'/g, prefix: 'security/' },
  { pattern: /from '(?:[^']*\/)?daemon\/([a-z0-9-]+(?:\/[a-z0-9-]+)*)\.js'/g, prefix: 'daemon/' },
  { pattern: /from '[^']*tenant\/(data-layout)\.js'/g, prefix: 'tenant/' },
]

function* mechanicsImportedBy(source: string): Generator<string> {
  for (const { pattern, prefix } of MECHANIC_SPECIFIERS) {
    for (const match of source.matchAll(pattern)) yield `${prefix}${match[1] as string}`
  }
}

/**
 * Every `<adapter file> -> <mechanic module>` edge that exists today, as the
 * strings the allowlist is written in.
 *
 * A mechanic is named by its FULL path under `store/`, at whatever depth, so
 * the database layer appears as `db/<module>` and cannot be confused with a
 * same-named module at the top level. That nesting used to be invisible: the
 * matcher read a single path segment, so every `store/db/**` import passed the
 * guard silently — a blind spot, not a decision, and the kind that reads as
 * coverage until someone measures it.
 *
 * The depth is deliberately unbounded rather than spelling out the one level
 * that exists today. `store/db/` is how deep the tree happens to go, not a
 * property of it, and a matcher that enumerates the depths it has seen is the
 * same blind spot waiting one directory further down.
 *
 * `exemptFiles` are files inside an adapter tree that are NOT adapters (see
 * `ADAPTER_SCAN_EXEMPT_FILES`); they are skipped whole rather than having
 * their edges allowlisted, because a composition root's edges are not debt
 * that can ever shrink.
 *
 * `serverDir` is `packages/mcp-server/src/server`.
 */
export function findAdapterMechanicEdges(
  serverDir: string,
  excludedMechanics: readonly string[],
  exemptFiles: readonly string[] = [],
): string[] {
  const excluded = new Set(excludedMechanics)
  const exempt = new Set(exemptFiles)
  const edges = new Set<string>()
  for (const base of ADAPTER_DIRS) {
    const dir = join(serverDir, base)
    for (const file of walk(dir, { include: isAdapterSource })) {
      const from = relative(serverDir, file).split('\\').join('/')
      if (exempt.has(from)) continue
      for (const mechanic of mechanicsImportedBy(readFileSync(file, 'utf8'))) {
        if (!excluded.has(mechanic)) edges.add(`${from} -> ${mechanic}`)
      }
    }
  }
  return [...edges].sort()
}
