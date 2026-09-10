// The one property `polyline-geometry.ts` has to keep: nothing it judges
// reads it. The drawing score and the scoreboards' oracles share it so a
// crossing means one thing across every instrument; the router, tidy and
// the bubble placer under `layout/` keep their own geometry, because an
// oracle that shared a primitive with the code it judges would agree with
// that code's mistakes by construction. A static scan, since the package
// boundary cannot see a same-package import.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const JUDGED = join(SRC, 'layout')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return name.endsWith('.ts') && !name.includes('.test.') ? [path] : []
  })
}

describe('polyline-geometry is read by the instruments, never by what they judge', () => {
  const files = sourceFiles(JUDGED)

  it('scans the layout it judges rather than an empty directory', () => {
    expect(files.length).toBeGreaterThan(14)
  })

  it('no production module under layout/ imports it', () => {
    const offenders = files.filter((path) =>
      /from\s+['"][^'"]*polyline-geometry(\.js)?['"]/.test(readFileSync(path, 'utf8')),
    )
    expect(offenders.map((p) => relative(SRC, p))).toEqual([])
  })
})
