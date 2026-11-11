/**
 * `define-your-own-stencils.md` copies the bundled stencils into a table, and
 * a hand copy drifts in silence: the page called `visual.service` "a
 * rectangle" after it became an octagon, and its silhouette list omitted the
 * octagon. The page is held against `assets/stencils.json`, the file the
 * bundled stencils are written in.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const read = (file: string): string => readFileSync(join(REPO_ROOT, file), 'utf-8')

/** Each bundled stencil's bare name and the silhouette its shape facet sets. */
function bundledSilhouettes(): Map<string, string> {
  const table = JSON.parse(read('packages/plugin-visual/src/assets/stencils.json')) as Record<
    string,
    { facets: Record<string, { kind?: string }> }
  >
  const silhouettes = new Map<string, string>()
  for (const [name, stencil] of Object.entries(table)) {
    const kind = stencil.facets['visual.shape/v0']?.kind
    if (kind !== undefined) silhouettes.set(name, kind)
  }
  return silhouettes
}

/** The silhouettes `visual.shape/v0` accepts, from the contract that generates its schema. */
function shapeKinds(): string[] {
  const contract = JSON.parse(read('contracts/facets/visual/visual.schema.json')) as {
    $defs: { VisualShapeKind: { enum: string[] } }
  }
  return contract.$defs.VisualShapeKind.enum
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
