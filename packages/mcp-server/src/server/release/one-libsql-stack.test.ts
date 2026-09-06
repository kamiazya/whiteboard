// The server image must carry ONE libsql stack, and which one is not a
// cosmetic preference.
//
// @libsql/kysely-libsql@0.4.1 is the latest and asks for @libsql/client@^0.8.0.
// The manifest also declares @libsql/client@^0.17.3 directly, and a comment in
// store/db/index.ts used to say that pin "forces the whole workspace onto" one
// version. It does not — a direct dependency does not constrain a transitive
// one — so pnpm resolved both, the dialect ran on 0.8.1, and the image shipped
// libsql@0.3.19's native bindings.
//
// 0.3.19's musl prebuild fails to load on current Alpine (`fcntl64: symbol not
// found`): the image built and could not start, and the base moved to Debian to
// get past it. Nothing noticed because nothing ran the container until the
// docker smokes were promoted to CI.
//
// The fix is a pnpm override, the mechanism this repo already uses for CVE
// bumps. This reads the lockfile so a future `@libsql/kysely-libsql` bump —
// or a dropped override — reintroduces the second stack loudly rather than by
// growing the image and waiting for a runtime that cannot start.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

const lockfile = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf-8')
const workspaceYaml = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf-8')

/** Every version of `name` the lockfile has a package entry for. */
function resolvedVersions(name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const entry = new RegExp(`^ {2}'?${escaped}@([0-9][^'":]*)'?:`, 'gm')
  return [...new Set([...lockfile.matchAll(entry)].map((m) => m[1]))].sort()
}

describe('the tree resolves one libsql stack', () => {
  it('reads a lockfile that actually mentions libsql', () => {
    // A regex that stops matching reports "exactly one version" for every
    // package, which is the answer this test exists to distrust.
    expect(resolvedVersions('@libsql/client').length).toBeGreaterThan(0)
    expect(resolvedVersions('libsql').length).toBeGreaterThan(0)
  })

  it('resolves exactly one @libsql/client', () => {
    expect(resolvedVersions('@libsql/client')).toEqual(['0.17.3'])
  })

  it('resolves exactly one native libsql', () => {
    expect(resolvedVersions('libsql')).toEqual(['0.5.29'])
  })

  it('keeps the override that makes that true', () => {
    // Without it, @libsql/kysely-libsql's own ^0.8.0 range wins for its own
    // subtree and the second stack comes back.
    expect(workspaceYaml).toMatch(/"@libsql\/client@<0\.17\.3":/)
  })
})
