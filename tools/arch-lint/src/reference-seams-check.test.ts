/**
 * References resolve in ONE place: canvas-render's `referenceSeams` is the
 * only producer of the four seams a layout reads to draw what a document
 * points at (`resolveAlias`, `resolveTitle`, `resolveEmbed`,
 * `resolveReference`). This scan is the executable half of that rule.
 *
 * Why it exists: each composition root used to write those seams by hand,
 * and the layout — total by design — drew placeholders for whichever one a
 * root forgot rather than failing. The web preview drew a canvas behind
 * `![[path]]` while `wb_scene_render` refused the document; the daemon
 * resolved file references to markdown bodies while the browser editor
 * resolved them to canvases too. Nothing was red, because a missing seam is
 * a legitimate state for a render that resolves nothing on purpose. So the
 * rule cannot be "every surface wires every seam"; it is "no surface
 * DEFINES a seam", and that a scan can hold.
 *
 * A root may still name a seam to pass it along (`resolveReference:
 * options.resolveReference`), wrap the bundle's seam with plain-data chrome
 * (`overlayReferences`), or hand `referenceSeams` its own alias table as an
 * INPUT. What it may not do is write the function body — `resolveEmbed:
 * (id) => …`, `const resolveReference = (ref) => …`, a method shorthand —
 * because that body is where "what does this reference draw as" gets
 * decided a second time.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findSeamDefinitions } from './reference-seam-definitions.js'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

/** Every composition root and UI package that lays documents out. */
const SCAN_DIRS = [
  'apps/web/src',
  'packages/canvas-viewer/src',
  'packages/server-core/src',
  'packages/mcp-server/src',
]

/**
 * Files allowed to define one, each with the reason. Empty today, and the
 * length is pinned so an addition is a decision in the diff — the same
 * both-sides discipline every arch-lint allowlist keeps.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {}

const files: string[] = []
for (const dir of SCAN_DIRS) walkSourceFiles(join(REPO_ROOT, dir), files)
const production = files.filter((path) => !isTestPath(path))

/** What the detector must catch, and what it must let through. */
const DEFINITION_FIXTURES: readonly { readonly source: string; readonly defines: boolean }[] = [
  { source: 'const x = { resolveEmbed: (id) => undefined }', defines: true },
  { source: 'const x = { resolveEmbed: async (id: string): Promise<X> => y }', defines: true },
  { source: 'const resolveReference = (ref) => undefined', defines: true },
  { source: 'const resolveTitle = function (id) { return id }', defines: true },
  { source: "const x = { 'resolveReference': (ref) => undefined }", defines: true },
  { source: 'const x = { ["resolveAlias"]: (alias) => null }', defines: true },
  {
    source: 'const x = {\n  resolveReference(ref) {\n    return undefined\n  },\n}',
    defines: true,
  },
  {
    source: 'const x = {\n  resolveReference<T>(ref: T): X {\n    return y\n  },\n}',
    defines: true,
  },
  {
    source: 'const x = {\n  async resolveEmbed(id: string) {\n    return y\n  },\n}',
    defines: true,
  },
  { source: 'const x = { resolveReference: options.resolveReference }', defines: false },
  { source: 'const x = { resolveEmbed: seams.resolveEmbed, resolveTitle }', defines: false },
  { source: 'const resolveAlias = useMemo(() => table, [table])', defines: false },
  { source: 'referenceSeams(graph, { resolveAlias, resolveTitle })', defines: false },
  { source: '// resolveEmbed: (id) => this is prose about a seam', defines: false },
  { source: '/* const resolveReference = (ref) => in a comment */', defines: false },
  { source: "const note = '//'; const resolveReference = (ref) => undefined", defines: true },
  { source: "// don't\nconst resolveTitle = (id) => id", defines: true },
  { source: "const s = 'resolveEmbed: (id) => x'", defines: false },
  { source: 'function resolveReference(ref) {\n  return undefined\n}', defines: true },
  { source: 'export async function resolveEmbed(id) {\n  return y\n}', defines: true },
  { source: 'export default function resolveTitle(id: string) {\n  return id\n}', defines: true },
  { source: 'const x = { resolveEmbed: <T,>(id: T) => undefined }', defines: true },
  { source: 'const x = { resolveEmbed: async <T,>(id: T): Promise<X> => y }', defines: true },
  { source: 'const x = { resolveAlias: ((alias) => null) as Seam }', defines: true },
  { source: 'const resolveTitle: Seam = (id) => id', defines: true },
  { source: 'seams.resolveTitle = (id) => id', defines: true },
  { source: "seams['resolveEmbed'] = function (id) { return y }", defines: true },
  { source: 'class S {\n  resolveReference(ref) {\n    return undefined\n  }\n}', defines: true },
  { source: 'class S {\n  resolveAlias = (alias) => null\n}', defines: true },
  {
    // A function declaration handed on by shorthand is still a definition, wherever it ends up.
    source:
      'function resolveReference(ref) {\n  return undefined\n}\nexport const zzSeams = { resolveReference }',
    defines: true,
  },
  { source: 'declare function resolveEmbed(id: string): X', defines: false },
  { source: 'function other(resolveEmbed) { return resolveEmbed }', defines: false },
  { source: 'const { resolveEmbed } = seams', defines: false },
  {
    source: 'interface S { resolveEmbed: (id: string) => X; resolveTitle(id: string): string }',
    defines: false,
  },
  { source: 'type S = { resolveAlias: (alias: string) => string | null }', defines: false },
  { source: 'const x = { resolveEmbed: wrap((id) => y) }', defines: false },
]

describe('references resolve in one place', () => {
  it('recognises a seam definition in every spelling, and passes a hand-over through', () => {
    for (const { source, defines } of DEFINITION_FIXTURES) {
      expect(findSeamDefinitions('fixture.ts', source).length > 0, source).toBe(defines)
    }
  })

  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(production.length).toBeGreaterThan(200)
  })

  it('no composition root or UI package defines a reference seam by hand', () => {
    const hits: string[] = []
    for (const path of production) {
      const rel = relative(REPO_ROOT, path).split(sep).join('/')
      if (ALLOWLIST[rel] !== undefined) continue
      for (const { shape, text } of findSeamDefinitions(path, readFileSync(path, 'utf8'))) {
        hits.push(`${rel}: ${shape} — \`${text}\``)
      }
    }
    expect(
      hits,
      'a reference seam is defined outside canvas-render/src/references — build it with `referenceSeams` over a loaded graph instead, so every surface answers the same way',
    ).toEqual([])
  })

  it('every allowlist entry still names a file that defines one', () => {
    const stale = Object.keys(ALLOWLIST).filter((rel) => {
      const path = join(REPO_ROOT, rel)
      try {
        return findSeamDefinitions(path, readFileSync(path, 'utf8')).length === 0
      } catch {
        return true
      }
    })
    expect(
      stale,
      'an entry that outlives its definition is how an allowlist stops being read',
    ).toEqual([])
  })

  it('holds the allowlist at its declared ceiling', () => {
    expect(Object.keys(ALLOWLIST)).toHaveLength(0)
  })
})
