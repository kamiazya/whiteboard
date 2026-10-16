/**
 * `view-canvas-in-chat.md` is where a reader of a client WITHOUT MCP Apps
 * support learns the JSON `canvas_view` hands them, so a script gets written
 * from it. A hand copy of the shape drifts in silence: the page named a
 * `label` key no reference has ever carried, and omitted `name`,
 * `documentId`, `canvas`, `style` and `themeFont`. The page's two backticked
 * key lists are held to the schemas' keys, optionality included, read as
 * text because arch-lint imports no package's source.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const read = (file: string): string => readFileSync(join(REPO_ROOT, file), 'utf-8')

/**
 * The top-level keys of `export const <name> = z.object({...}).strict()`, each
 * marked `?` when optional, in the `key?` spelling the page uses. A key is a
 * line at the object's own indent, so a nested object's keys are not read.
 */
function schemaKeys(file: string, name: string): string[] {
  const source = read(file)
  const start = source.indexOf(`export const ${name} = z`)
  if (start < 0) return []
  const block = source.slice(start, source.indexOf('\n  .strict()', start))
  return [...block.matchAll(/^ {4}(\w+): (.*)$/gm)].map(([, key, value]) =>
    /\.optional\(\),?$/.test(value as string) ? `${key}?` : (key as string),
  )
}

/** The `{ a, b? }` list that follows `lead` in the page, split into keys. */
function pageKeys(page: string, lead: RegExp): string[] {
  const list = new RegExp(`${lead.source}\\s+\`\\{([^}]*)\\}\``).exec(page)?.[1]
  return (list ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key !== '')
}

const page = read('docs/how-to/view-canvas-in-chat.md')
const output = schemaKeys('packages/server-core/src/tools/canvas-view.ts', 'canvasViewOutputSchema')
const reference = schemaKeys(
  'packages/canvas-render/src/references/wire-schema.ts',
  'loadedReferenceWireSchema',
)

describe('view-canvas-in-chat.md against canvas_view’s output schema', () => {
  it('reads real schemas and a real page', () => {
    expect(output).toContain('scene')
    expect(output.length).toBeGreaterThanOrEqual(5)
    expect(reference.length).toBeGreaterThanOrEqual(3)
  })

  it('names exactly the structuredContent keys', () => {
    expect(pageKeys(page, /`structuredContent` carries/).sort()).toEqual([...output].sort())
  })

  it('names exactly the keys one reference resolves to', () => {
    expect(pageKeys(page, /reference to what it resolves to,/).sort()).toEqual(
      [...reference].sort(),
    )
  })
})
