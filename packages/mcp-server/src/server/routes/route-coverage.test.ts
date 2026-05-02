// Meta test: every Hono route file under src/server/routes/ must ship with a
// sibling *.test.ts. Catches the common "added a new route, forgot a test"
// regression at the layer that actually changes shape with new files (the
// existing per-route tests cover behaviour but don't enforce new routes
// arrive with coverage).
//
// Why include validators-only files (auth, ws-validation, ws-auth)? They are
// part of the route surface — auth gates mutation, ws-validation parses
// inbound WS frames — so a missing test there is just as risky.

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

function listRouteSourceFiles(): string[] {
  return readdirSync(here)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.endsWith('.test.ts'))
    .filter((name) => !name.endsWith('.d.ts'))
    .sort()
}

describe('routes coverage', () => {
  it('every route source file has a sibling .test.ts', () => {
    const sources = listRouteSourceFiles()
    expect(sources.length).toBeGreaterThan(0)
    const testFiles = new Set(
      readdirSync(here).filter((name) => name.endsWith('.test.ts')),
    )
    const missing = sources.filter(
      (src) => !testFiles.has(src.replace(/\.ts$/, '.test.ts')),
    )
    expect(
      missing,
      `add a sibling .test.ts for: ${missing.map((f) => join('routes', f)).join(', ')}`,
    ).toEqual([])
  })

  it('keeps route-coverage itself listed so removing this file is a deliberate choice', () => {
    expect(readdirSync(here)).toContain('route-coverage.test.ts')
  })
})
