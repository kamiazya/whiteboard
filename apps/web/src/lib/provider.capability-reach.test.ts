// A capability flag that nothing reads is a wiring gap that every other gate
// passes: the const map compiles, both provider kinds set it, and the unit
// tests assert its value — so it looks covered while gating nothing. Three
// (`canvasReadWrite`, `migrationExport`, `migrationImport`) sat that way until
// an audit found them. This is the executable rung that stops the next one:
// every declared capability must be read somewhere outside its own module.

import { describe, expect, it } from 'vitest'
import { BROWSER_CAPABILITIES } from './provider.js'

// `?raw` rather than node:fs — apps/web is browser-only and must not import a
// Node builtin (the same reason App.lazy-coverage.test.ts reads files this way).
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function readerModules(): Array<[string, string]> {
  return Object.entries(sources).filter(
    ([path]) => !path.includes('.test.') && !path.endsWith('/lib/provider.ts'),
  )
}

describe('every declared capability is read by production code', () => {
  const capabilities = Object.keys(BROWSER_CAPABILITIES)

  it('declares at least one capability, so an empty map cannot pass vacuously', () => {
    expect(capabilities.length).toBeGreaterThan(0)
  })

  it.each(capabilities)('%s gates something', (name) => {
    const readers = readerModules()
      .filter(([, text]) => new RegExp(`capabilities\\??\\.${name}\\b`).test(text))
      .map(([path]) => path)

    expect(
      readers,
      `capabilities.${name} is declared but never read — wire it to the surface it is meant to gate, or delete it from WhiteboardCapabilities`,
    ).not.toEqual([])
  })
})
