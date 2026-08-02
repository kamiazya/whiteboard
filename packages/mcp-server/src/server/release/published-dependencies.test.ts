// Guard: @kamiazya/whiteboard-mcp is published to npm, so every entry under
// dependencies/peerDependencies/optionalDependencies is a runtime download for
// every installing user. This test fails if any @excalidraw/* package
// reappears there, so a re-import of the removed Excalidraw-based renderer
// cannot silently ship as a dependency again without at least one red test.
//
// Deliberately narrow: it only names @excalidraw/*, not the general class of
// "unused runtime dependency in a composition-root package.json" (that would
// need arch-lint's allowedThirdParty coverage extended to composition roots,
// which is out of scope here — see architecture-map.md).
//
// Reads the manifest keys directly rather than `node_modules` state, so the
// assertion is deterministic and install-independent.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_JSON_PATH = join(__dirname, '../../../package.json')

function readPackageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'))
}

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const

describe('published mcp-server dependency set', () => {
  it('parses a non-empty dependencies block (sanity check for the guard itself)', () => {
    const pkg = readPackageJson()
    const dependencies = pkg.dependencies as Record<string, string> | undefined
    expect(dependencies).toBeDefined()
    expect(Object.keys(dependencies ?? {}).length).toBeGreaterThan(0)
  })

  it('never declares an @excalidraw/* package as a runtime dependency', () => {
    const pkg = readPackageJson()
    const offenders: string[] = []
    for (const field of DEPENDENCY_FIELDS) {
      const block = pkg[field] as Record<string, string> | undefined
      if (!block) continue
      for (const name of Object.keys(block)) {
        if (name.startsWith('@excalidraw/')) {
          offenders.push(`${field}.${name}`)
        }
      }
    }
    expect(offenders, `unexpected @excalidraw/* entries: ${offenders.join(', ')}`).toEqual([])
  })
})
