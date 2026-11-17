// The one property `polyline-geometry.ts` has to keep: nothing it judges
// reads it. The drawing score and the scoreboards' oracles share it so a
// crossing means one thing across every instrument; what they judge (tidy,
// the SVG backend, the layout's own switches — the router and the composer
// are the Rust core's now) keeps its own geometry, because an oracle that
// shared a primitive with the code it judges would agree with that code's
// mistakes by construction. A static scan over every production module
// outside the instruments (`quality/`) and the fixtures (`test-utils/`),
// since the package boundary cannot see a same-package import.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const INSTRUMENTS = new Set([join(SRC, 'quality'), join(SRC, 'test-utils')])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return INSTRUMENTS.has(path) ? [] : sourceFiles(path)
    return name.endsWith('.ts') && !name.includes('.test.') ? [path] : []
  })
}

describe('polyline-geometry is read by the instruments, never by what they judge', () => {
  const files = sourceFiles(SRC)

  it('scans the modules it judges rather than an empty directory', () => {
    expect(files.length).toBeGreaterThan(60)
  })

  it('no production module outside the instruments imports it', () => {
    const offenders = files.filter((path) =>
      /from\s+['"][^'"]*polyline-geometry(\.js)?['"]/.test(readFileSync(path, 'utf8')),
    )
    expect(offenders.map((p) => relative(SRC, p))).toEqual([])
  })
})
