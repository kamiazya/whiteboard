import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

/**
 * A surface somebody OUTSIDE this repo reads or writes, carrying a whole
 * spatial document. Each must name codec's wire schema
 * (`jsonCanvasDocumentSchema`), never the product's own model.
 *
 * The distinction is invisible today — [ADR-0033](../../../../../docs/contributing/adr/0033-model-and-format.md)
 * slice 1 left the wire schema an alias of the model's — and that is exactly
 * why it is pinned now rather than later. The moment the model gains a field
 * the format cannot hold, a surface still pointing at the model starts
 * publishing a shape no JSON Canvas consumer can read, and nothing else in
 * the suite would say so: both schemas parse every document either names.
 *
 * The assert-a-rule ledger family of `.claude/rules/coverage-ledger.md` — one
 * rule over every entry, no per-item vocabulary. Adding a surface means adding
 * a row; the rule is what a row has to satisfy.
 */
const WIRE_SURFACES: Readonly<Record<string, string>> = {
  'packages/server-core/src/tools/canvas-view.ts':
    "the canvas_view MCP tool's outputSchema — published to every client through tools/list",
  'packages/canvas-viewer/src/scene.ts':
    "the published widget's input contract; a third party's JSON Canvas file is what arrives",
}

describe('a surface read from outside this repo names the wire schema, not the model', () => {
  it('names at least the two surfaces known to carry a whole document', () => {
    // A plausible count of its own, because a table that silently emptied
    // would pass every rule below by having nothing to check.
    expect(Object.keys(WIRE_SURFACES).length).toBeGreaterThanOrEqual(2)
  })

  for (const [path, why] of Object.entries(WIRE_SURFACES)) {
    it(`${path} names jsonCanvasDocumentSchema — ${why}`, () => {
      const source = readFileSync(resolve(repoRoot, path), 'utf8')
      expect(source).toContain('jsonCanvasDocumentSchema')
      expect(source).not.toContain('spatialCanvasSchema')
    })
  }
})
