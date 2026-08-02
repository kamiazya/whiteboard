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
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname → packages/mcp-server/src/server/release
const PACKAGE_ROOT = resolve(__dirname, '../../..')

const RUNTIME_DEPENDENCY_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

const mcpPackage = JSON.parse(
  readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8'),
) as Partial<Record<(typeof RUNTIME_DEPENDENCY_FIELDS)[number], Record<string, string>>>

describe('published mcp-server dependency set', () => {
  it('parses a non-empty dependencies block (sanity check for the guard itself)', () => {
    expect(Object.keys(mcpPackage.dependencies ?? {})).not.toHaveLength(0)
  })

  it('never declares an @excalidraw/* package as a runtime dependency', () => {
    const offenders = RUNTIME_DEPENDENCY_FIELDS.flatMap((field) =>
      Object.keys(mcpPackage[field] ?? {})
        .filter((name) => name.startsWith('@excalidraw/'))
        .map((name) => `${field}.${name}`),
    )
    expect(offenders, `unexpected @excalidraw/* entries: ${offenders.join(', ')}`).toEqual([])
  })
})
