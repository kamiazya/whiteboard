/**
 * `define-your-own-stencils.md` copies the bundled stencils into a table, and
 * a hand copy drifts in silence: the page called `visual.service` "a
 * rectangle" after it became an octagon, and its silhouette list omitted the
 * octagon. The page is held against `stencils.ts`, read as text because
 * arch-lint imports no package's source.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const read = (file: string): string => readFileSync(join(REPO_ROOT, file), 'utf-8')

/** Each bundled stencil's bare name and the silhouette its shape facet sets. */
function bundledSilhouettes(): Map<string, string> {
  const source = read('packages/plugin-visual/src/stencils.ts')
  const block = source.slice(source.indexOf('export const VISUAL_STENCILS'))
  const silhouettes = new Map<string, string>()
  for (const chunk of block.split(/^ {2}(?=\w+: \{$)/m).slice(1)) {
    const name = /^(\w+): \{/.exec(chunk)?.[1]
    const kind = /\[SHAPE_KEY\]: \{ kind: '(\w+)' \}/.exec(chunk)?.[1]
    if (name !== undefined && kind !== undefined) silhouettes.set(name, kind)
  }
  return silhouettes
}

/** The silhouettes `visual.shape/v0` accepts, from its enum. */
function shapeKinds(): string[] {
  const body = /kind: z\.enum\(\[([^\]]*)\]\)/.exec(read('packages/plugin-visual/src/data.ts'))?.[1]
  return [...(body ?? '').matchAll(/'(\w+)'/g)].map((match) => match[1] as string)
}

const page = read('docs/how-to/define-your-own-stencils.md')
const bundled = bundledSilhouettes()

describe('define-your-own-stencils.md against the bundled stencils', () => {
  it('reads a real table and a real registry', () => {
    expect(bundled.size).toBeGreaterThanOrEqual(6)
    expect(shapeKinds().length).toBeGreaterThanOrEqual(6)
  })

  it.each([...bundled])('draws visual.%s as the silhouette it sets (%s)', (name, kind) => {
    const row = page.split('\n').find((line) => line.startsWith(`| \`visual.${name}\``))
    expect(row, `no table row for visual.${name}`).toBeDefined()
    const drawnAs = /\|\s*an? ([\w ]+?)\s*\|$/.exec(row ?? '')?.[1]
    expect(drawnAs).toBe(kind)
  })

  it('has a row for no stencil that is not bundled', () => {
    const rows = [...page.matchAll(/^\| `visual\.(\w+)`/gm)].map((match) => match[1])
    expect(rows.filter((name) => !bundled.has(name as string))).toEqual([])
  })

  it('lists every silhouette a stencil may set', () => {
    const list = /The silhouettes a stencil can\s+set \(`visual\.shape\/v0`\) are ([^;]*?);/.exec(
      page,
    )?.[1]
    const named = [...(list ?? '').matchAll(/`(\w+)`/g)].map((match) => match[1])
    expect(named.sort()).toEqual(shapeKinds().sort())
  })
})
