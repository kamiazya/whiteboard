// Meta test: every Hono route file under src/server/routes/ (including
// subdirectories) must ship with a sibling *.test.ts. Catches the common
// "added a new route, forgot a test" regression at the layer that actually
// changes shape with new files.
//
// Why include validators-only files (auth, ws-validation, ws-auth)? They are
// part of the route surface — auth gates mutation, ws-validation parses
// inbound WS frames — so a missing test there is just as risky.

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

function isRouteSource(name: string): boolean {
  return (
    name.endsWith('.ts') &&
    !name.endsWith('.test.ts') &&
    !name.endsWith('.d.ts') &&
    !name.startsWith('_')
  )
}

function collectRouteFiles(dir: string, prefix = ''): { sources: string[]; tests: Set<string> } {
  const sources: string[] = []
  const tests = new Set<string>()

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) {
      const sub = collectRouteFiles(join(dir, entry.name), rel)
      sources.push(...sub.sources)
      for (const t of sub.tests) tests.add(t)
    } else if (entry.name.endsWith('.test.ts')) {
      tests.add(rel)
    } else if (isRouteSource(entry.name)) {
      sources.push(rel)
    }
  }
  return { sources: sources.sort(), tests }
}

describe('routes coverage', () => {
  it('every route source file has a sibling .test.ts', () => {
    const { sources, tests } = collectRouteFiles(here)
    expect(sources.length).toBeGreaterThan(0)
    const missing = sources.filter((src) => !tests.has(src.replace(/\.ts$/, '.test.ts')))
    expect(
      missing,
      `add a sibling .test.ts for: ${missing.map((f) => join('routes', f)).join(', ')}`,
    ).toEqual([])
  })

  it('keeps route-coverage itself listed so removing this file is a deliberate choice', () => {
    expect(readdirSync(here)).toContain('route-coverage.test.ts')
  })
})
