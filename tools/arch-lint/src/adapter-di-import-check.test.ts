/**
 * An ADAPTER never composes its own dependencies.
 *
 * `server/routes/**` and `server/mcp/**` are ADR-0018's adapters: they
 * translate a request onto an operation the composition root handed them.
 * For a long time most routers also carried a fallback — "no `serverDeps`?
 * resolve the production wiring yourself through `di/`" — which read as a
 * convenience and was a second composition path: fourteen call sites in
 * eight files built `ServerDeps` of their own, none of them carrying what
 * the root attaches (the live-audience notifier), and a router threaded
 * without the field compiled clean and passed every test that only ever
 * took the fallback. `serverDeps` is required now, and this scan is what
 * keeps the fallback from growing back: an adapter that imports the di
 * graph fails here, whatever it imports it for.
 *
 * The one adapter-adjacent module allowed to know the graph is the stdio
 * root (`server/mcp/index.ts`), which IS a composition root — it has nobody
 * above it to hand deps down — so it is listed by name rather than by
 * pattern.
 *
 * Specifiers come from the AST walk every other import scan uses, and are
 * judged by where they RESOLVE rather than by how they are spelled. A text
 * match on `from '../../di/'` missed a side-effect `import '...'`, a
 * double-quoted or template `import()` and a `require`, and read a
 * commented-out import as a violation.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adapterFiles } from './adapter-files.js'
import { collectRelativeImportEdges } from './cycle-check.js'
import { REPO_ROOT } from './scan-roots.js'

const SERVER_ROOT = join(REPO_ROOT, 'packages/mcp-server/src/server')
const DI_DIR = join(REPO_ROOT, 'packages/mcp-server/src/di')
/** Composition roots that live beside the adapters; each carries its reason. */
const COMPOSITION_ROOTS_AMONG_ADAPTERS: ReadonlySet<string> = new Set([
  // The packaged stdio entry: it is the root, so it resolves its own deps.
  'mcp/index.ts',
])

/** Whether `file` imports anything under `di/`, however the import is written. */
function importsDiGraph(file: string, source: string): boolean {
  return collectRelativeImportEdges(file, source).some(({ specifier }) => {
    const target = resolve(dirname(file), specifier)
    return target === DI_DIR || target.startsWith(DI_DIR + sep)
  })
}

describe('what counts as importing the di graph', () => {
  const at = join(SERVER_ROOT, 'routes/x.ts')
  it.each([
    ['a static import', "import { c } from '../../di/container.js'\n"],
    ['a side-effect import', "import '../../di/container.js'\n"],
    ['a re-export', "export { c } from '../../di/container.js'\n"],
    ['a single-quoted dynamic import', "export const f = () => import('../../di/container.js')\n"],
    ['a double-quoted dynamic import', 'export const f = () => import("../../di/container.js")\n'],
    ['a template dynamic import', 'export const f = () => import(`../../di/container.js`)\n'],
    ['a nested route', "import { c } from '../../../di/container.js'\n"],
  ])('finds %s', (_name, source) => {
    const file = _name === 'a nested route' ? join(SERVER_ROOT, 'routes/a/x.ts') : at
    expect(importsDiGraph(file, source)).toBe(true)
  })

  it.each([
    ['a commented-out import', "// import { c } from '../../di/container.js'\n"],
    ['a block-commented import', "/* import { c } from '../../di/container.js' */\n"],
    ['a string that names it', 'export const s = "import \'../../di/container.js\'"\n'],
    ['a sibling directory of the same prefix', "import { c } from '../../dir/container.js'\n"],
    ['a store module', "import { s } from '../store/document-store.js'\n"],
  ])('does not take %s for one', (_name, source) => {
    expect(importsDiGraph(at, source)).toBe(false)
  })
})

describe('an adapter never imports the di graph', () => {
  const files = adapterFiles(SERVER_ROOT)

  it('scans the adapter population', () => {
    // A walk that found nothing would pass the rule vacuously.
    expect(files.length).toBeGreaterThan(40)
  })

  it('finds no route or MCP adapter resolving its own ServerDeps through di/', () => {
    const offenders = files
      .map((full) => relative(SERVER_ROOT, full))
      .filter((rel) => !COMPOSITION_ROOTS_AMONG_ADAPTERS.has(rel))
      .filter((rel) =>
        importsDiGraph(join(SERVER_ROOT, rel), readFileSync(join(SERVER_ROOT, rel), 'utf8')),
      )
    expect(offenders).toEqual([])
  })

  it('lists no composition root that has stopped importing di/', () => {
    const stale = [...COMPOSITION_ROOTS_AMONG_ADAPTERS].filter(
      (rel) =>
        !importsDiGraph(join(SERVER_ROOT, rel), readFileSync(join(SERVER_ROOT, rel), 'utf8')),
    )
    expect(stale).toEqual([])
  })
})
