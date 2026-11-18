/**
 * ADR-0054's `PORTED_FUNCTIONS` ledger, held from both sides: the real tree
 * against the real ledger, and the checker against fixtures that plant each
 * way they can part.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkPortedFunctions,
  PORTED_FUNCTIONS,
  type PortedFunction,
  type ReadFile,
  switchKeys,
} from './ported-functions.js'
import { REPO_ROOT } from './scan-roots.js'

const readReal: ReadFile = (path) => {
  const full = join(REPO_ROOT, path)
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined
}

/**
 * A stage-2 entry the fixtures plant each departure on: the routing as it was
 * ledgered before its TypeScript went, so the checker's stage-2 and stage-3
 * shapes stay exercised now that no real entry of that name is at either.
 */
const entry: PortedFunction = {
  name: 'routeLayout',
  stage: 2,
  ts: { file: 'packages/canvas-render/src/layout-core.ts', export: 'routeLayout' },
  rust: { file: 'crates/bindings/wasm/src/spatial_edges.rs', fn: 'edge_route_layout' },
  shim: {
    module: '@kamiazya/whiteboard-core-wasm',
    file: 'packages/core-wasm/src/index.ts',
    member: 'routeLayout',
  },
}

/** A tree with just enough in it for `entry`, each file overridable. */
function tree(files: Record<string, string> = {}): ReadFile {
  const base: Record<string, string> = {
    [entry.ts.file]: 'export function routeLayout() {}\n',
    [entry.rust.file]: '#[wasm_bindgen]\npub fn edge_route_layout(input: &[f64]) {}\n',
    [entry.shim.file]: 'routeLayout() {}\n',
  }
  const all = { ...base, ...files }
  return (path) => all[path]
}

describe('PORTED_FUNCTIONS against the tree', () => {
  it('lists the ported functions and the real tree agrees with it', () => {
    expect(PORTED_FUNCTIONS.map((f) => f.name)).toEqual([
      'routeLayout',
      'layoutSpatialCanvas',
      'layoutMarkdown',
      'layoutSpatialEdges',
      'naturalNodeContentSize',
      'fittedTextNodeHeight',
      'edgeLabelPlacement',
      'labelObstacles',
      'frameTitleObstacles',
      'placeCommentBubble',
      'parseMarkdownBody',
      'resolveReferences',
      'parseOkf',
      'serializeOkf',
      'parseSpatial',
      'serializeSpatial',
      'partitionFacetWrites',
      'foldForSearch',
      'findFolded',
      'folderNamesOf',
      'searchableTexts',
      'snippetAround',
      'linkLabels',
      'excerpts',
      'fullTextSearch',
    ])
    expect(checkPortedFunctions(PORTED_FUNCTIONS, readReal)).toEqual([])
  })

  it('finds no per-function switch on LayoutCore: the core answers every layout it is handed', () => {
    const file = 'packages/canvas-render/src/layout-core.ts'
    const text = readReal(file) as string
    expect(text).toContain('export interface LayoutCore')
    expect(switchKeys(text, 'LayoutCore')).toBeUndefined()
  })
})

describe('the realm-dispatched functions at stage 4', () => {
  const codecs = PORTED_FUNCTIONS.filter((f) => f.realm !== undefined)

  it('are realm dispatchers with their TypeScript gone', () => {
    expect(codecs.map((f) => [f.name, f.stage, f.realm?.install])).toEqual([
      ['parseOkf', 4, 'installOkfCore'],
      ['serializeOkf', 4, 'installOkfCore'],
      ['parseSpatial', 4, 'installSpatialCore'],
      ['serializeSpatial', 4, 'installSpatialCore'],
      ['partitionFacetWrites', 4, 'installFacetWriteCore'],
      ['foldForSearch', 4, 'installSearchCore'],
      ['findFolded', 4, 'installSearchCore'],
      ['folderNamesOf', 4, 'installSearchCore'],
      ['searchableTexts', 4, 'installSearchCore'],
      ['snippetAround', 4, 'installSearchCore'],
      ['linkLabels', 4, 'installSearchCore'],
      ['excerpts', 4, 'installSearchCore'],
      ['fullTextSearch', 4, 'installSearchCore'],
    ])
    for (const f of codecs) {
      // The real files the entry says are gone are gone, so an empty `deleted` list cannot pass.
      expect(f.realm?.deleted.length).toBeGreaterThanOrEqual(2)
      for (const path of f.realm?.deleted ?? []) expect(readReal(path), path).toBeUndefined()
    }
  })
})

describe('the layout functions at stage 4', () => {
  const handed = PORTED_FUNCTIONS.filter((f) => f.handed !== undefined)

  it('ask the core they are handed, with their TypeScript gone', () => {
    expect(handed.map((f) => [f.name, f.stage])).toEqual([
      ['routeLayout', 4],
      ['layoutSpatialCanvas', 4],
      ['layoutMarkdown', 4],
      ['layoutSpatialEdges', 4],
      ['naturalNodeContentSize', 4],
      ['fittedTextNodeHeight', 4],
      ['edgeLabelPlacement', 4],
      ['labelObstacles', 4],
      ['frameTitleObstacles', 4],
      ['placeCommentBubble', 4],
    ])
    for (const f of handed) {
      // The real files the entry says are gone are gone, so an empty `deleted` list cannot pass.
      expect(f.handed?.deleted.length).toBeGreaterThanOrEqual(2)
      for (const path of f.handed?.deleted ?? []) expect(readReal(path), path).toBeUndefined()
    }
  })
})

describe('the absorbed functions at stage 4', () => {
  const absorbed = PORTED_FUNCTIONS.filter((f) => f.absorbed !== undefined)

  it('are the markdown parse and the reference resolution, with no TypeScript left', () => {
    expect(absorbed.map((f) => [f.name, f.stage])).toEqual([
      ['parseMarkdownBody', 4],
      ['resolveReferences', 4],
    ])
    for (const f of absorbed) {
      // The real files the entry says are gone are gone, so an empty `deleted` list cannot pass.
      expect(f.absorbed?.deleted.length).toBeGreaterThanOrEqual(2)
      for (const path of [f.ts.file, ...(f.absorbed?.deleted ?? [])]) {
        expect(readReal(path), path).toBeUndefined()
      }
    }
  })
})

describe('the ledger checker', () => {
  it('passes the fixture tree', () => {
    expect(checkPortedFunctions([entry], tree())).toEqual([])
  })

  it('fails a listed function whose TypeScript export is gone', () => {
    const read = tree({
      [entry.ts.file]: tree()(entry.ts.file)?.replace('export function', 'function') as string,
    })
    expect(checkPortedFunctions([entry], read)).toEqual([
      expect.stringContaining('no longer exports a function named routeLayout'),
    ])
  })

  it('fails a listed function whose file is gone', () => {
    const read: ReadFile = (path) => (path === entry.ts.file ? undefined : tree()(path))
    expect(checkPortedFunctions([entry], read)).toEqual(
      expect.arrayContaining([expect.stringContaining('does not exist')]),
    )
  })

  it('fails a listed function whose Rust export is gone', () => {
    const read = tree({ [entry.rust.file]: 'pub fn other() {}\n' })
    expect(checkPortedFunctions([entry], read)).toEqual([
      expect.stringContaining('declares no `pub fn edge_route_layout`'),
    ])
  })

  it('fails a stage-3 function the TypeScript still implements', () => {
    const rust: PortedFunction = { ...entry, stage: 3 }
    expect(checkPortedFunctions([rust], tree())).toEqual([
      expect.stringContaining('still implements routeLayout'),
    ])
  })

  it('passes a stage-3 function whose TypeScript export re-exports the shim', () => {
    const rust: PortedFunction = { ...entry, stage: 3 }
    const read = tree({
      [entry.ts.file]:
        `export interface LayoutCore { readonly impl: { readonly routeLayout: string } }\nexport { routeLayout } from '${entry.shim.module}'\n`,
    })
    expect(checkPortedFunctions([rust], read)).toEqual([])
  })

  it('fails a stage-3 function that re-exports from somewhere else', () => {
    const rust: PortedFunction = { ...entry, stage: 3 }
    const read = tree({
      [entry.ts.file]:
        `export interface LayoutCore { readonly impl: { readonly routeLayout: string } }\nexport { routeLayout } from './elsewhere.js'\n`,
    })
    expect(checkPortedFunctions([rust], read)).toEqual([expect.stringContaining('needs')])
  })

  it('fails a function listed twice', () => {
    expect(checkPortedFunctions([entry, entry], tree())).toEqual(
      expect.arrayContaining(['routeLayout: listed twice']),
    )
  })

  describe('a handed core at stage 4', () => {
    const handed: PortedFunction = { ...entry, stage: 4, handed: { deleted: ['old/impl.ts'] } }

    it('passes when the export is declared and the TypeScript is gone', () => {
      expect(checkPortedFunctions([handed], tree())).toEqual([])
    })

    it('fails when a file where the TypeScript lived still exists', () => {
      const read = tree({ 'old/impl.ts': 'export {}' })
      expect(checkPortedFunctions([handed], read)).toEqual([
        expect.stringContaining('old/impl.ts, where the TypeScript lived, still exists'),
      ])
    })

    it('fails when the export itself is gone', () => {
      const read = tree({ [entry.ts.file]: 'export function other() {}\n' })
      expect(checkPortedFunctions([handed], read)).toEqual([
        expect.stringContaining('no longer exports a function named routeLayout'),
      ])
    })

    it('is stage 4 only', () => {
      expect(checkPortedFunctions([{ ...handed, stage: 3 }], tree())).toEqual([
        expect.stringContaining("a handed core is stage 4's shape, not stage 3's"),
      ])
    })
  })

  describe('an absorbed function at stage 4', () => {
    const absorbed: PortedFunction = { ...entry, stage: 4, absorbed: { deleted: ['old/impl.ts'] } }
    const gone: ReadFile = (path) => (path === entry.ts.file ? undefined : tree()(path))

    it('passes when no TypeScript file is left, the named one included', () => {
      expect(checkPortedFunctions([absorbed], gone)).toEqual([])
    })

    it('fails when the file the entry names still exists', () => {
      expect(checkPortedFunctions([absorbed], tree())).toEqual([
        expect.stringContaining(`${entry.ts.file}, where the TypeScript lived, still exists`),
      ])
    })

    it('fails when a file where the TypeScript lived still exists', () => {
      const read: ReadFile = (path) => (path === 'old/impl.ts' ? 'export {}' : gone(path))
      expect(checkPortedFunctions([absorbed], read)).toEqual([
        expect.stringContaining('old/impl.ts, where the TypeScript lived, still exists'),
      ])
    })

    it('fails when the Rust export is gone, which is now the only implementation', () => {
      const read: ReadFile = (path) =>
        path === entry.rust.file ? 'pub fn other() {}\n' : gone(path)
      expect(checkPortedFunctions([absorbed], read)).toEqual([
        expect.stringContaining('declares no `pub fn edge_route_layout`'),
      ])
    })

    it('is stage 4 only', () => {
      expect(checkPortedFunctions([{ ...absorbed, stage: 3 }], gone)).toEqual([
        expect.stringContaining("an absorbed function is stage 4's shape, not stage 3's"),
      ])
    })
  })

  describe('a realm dispatcher at stage 4', () => {
    const realm: PortedFunction = {
      ...entry,
      stage: 4,
      realm: { install: 'installCore', deleted: ['old/impl.ts'] },
    }
    const dispatcher = 'export function installCore() {}\nexport function routeLayout() {}\n'

    it('passes when the dispatcher and the installer are declared and the TypeScript is gone', () => {
      expect(checkPortedFunctions([realm], tree({ [entry.ts.file]: dispatcher }))).toEqual([])
    })

    it('fails when a file where the TypeScript lived still exists', () => {
      const read = tree({ [entry.ts.file]: dispatcher, 'old/impl.ts': 'export {}' })
      expect(checkPortedFunctions([realm], read)).toEqual([
        expect.stringContaining('old/impl.ts, where the TypeScript lived, still exists'),
      ])
    })

    it('fails when no realm can install a core', () => {
      const read = tree({ [entry.ts.file]: 'export function routeLayout() {}\n' })
      expect(checkPortedFunctions([realm], read)).toEqual([
        expect.stringContaining('declares no installCore'),
      ])
    })

    it('fails when the dispatcher itself is gone', () => {
      const read = tree({ [entry.ts.file]: 'export function installCore() {}\n' })
      expect(checkPortedFunctions([realm], read)).toEqual([
        expect.stringContaining('no longer exports a function named routeLayout'),
      ])
    })

    it('is stage 4 only', () => {
      expect(
        checkPortedFunctions([{ ...realm, stage: 3 }], tree({ [entry.ts.file]: dispatcher })),
      ).toEqual([expect.stringContaining("stage 4's shape, not stage 3's")])
    })
  })
})
