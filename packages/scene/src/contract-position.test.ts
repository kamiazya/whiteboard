// This package exists for its POSITION, not its contents — below the
// renderer and below every plugin. So what is worth pinning is the position:
// its manifest may not reach up, and its source may not import a thing it is
// supposed to sit under.
//
// Read with `?raw` rather than `node:fs`: the same reason plugin-visual's
// guard does it — this package must stay loadable wherever its consumers run.

import { describe, expect, it } from 'vitest'
import manifest from '../package.json' with { type: 'json' }

const sources = import.meta.glob('./**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Anything that would put this package back above one of its consumers. */
const ABOVE = ['@kamiazya/whiteboard-canvas-render', '@kamiazya/whiteboard-plugin-visual']

describe('the contract sits below both sides', () => {
  it('declares only the two packages the contract is written in terms of', () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@kamiazya/whiteboard-facet-engine',
      '@kamiazya/whiteboard-model',
    ])
  })

  it('imports neither the renderer nor a plugin, in any source file', () => {
    const offenders: string[] = []
    for (const [path, source] of Object.entries(sources)) {
      if (path.endsWith('.test.ts')) continue
      for (const name of ABOVE) {
        if (String(source).includes(name)) offenders.push(`${path}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('finds the sources it is meant to scan', () => {
    // A glob that stopped matching would report "no offenders", which reads
    // exactly like a package that stopped reaching up.
    expect(Object.keys(sources).length).toBeGreaterThan(2)
  })
})

// That the vocabulary is types only (no export emits code) is asked of the
// compiler in `tools/arch-lint`'s `scene-types-only.test.ts`: the TypeScript
// JS API is not a dependency of this package, and a regex over `export const`
// here passed an `async function`, an `abstract class`, a default export and a
// namespace.
