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

const entry = PORTED_FUNCTIONS[0] as PortedFunction

/** A tree with just enough in it for `entry`, each file overridable. */
function tree(files: Record<string, string> = {}): ReadFile {
  const base: Record<string, string> = {
    [entry.ts.file]:
      'export interface LayoutCore { readonly impl: { readonly routeLayout: string } }\nexport function routeLayout() {}\n',
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
      'parseOkf',
      'serializeOkf',
      'parseSpatial',
      'serializeSpatial',
    ])
    expect(checkPortedFunctions(PORTED_FUNCTIONS, readReal)).toEqual([])
  })

  it('reads the real switch keys, so an empty read cannot pass for agreement', () => {
    const slot = entry.switch as NonNullable<PortedFunction['switch']>
    const keys = switchKeys(readReal(slot.file) as string, slot.interface)
    expect(keys).toEqual(['routeLayout'])
  })
})

describe('the OKF envelope at stage 4', () => {
  const okf = PORTED_FUNCTIONS.filter((f) => f.name === 'parseOkf' || f.name === 'serializeOkf')

  it('is a realm dispatcher with its TypeScript gone and no switch left', () => {
    expect(okf.map((f) => [f.stage, f.switch, f.realm?.install])).toEqual([
      [4, undefined, 'installOkfCore'],
      [4, undefined, 'installOkfCore'],
    ])
    for (const f of okf) {
      // The real files the entry says are gone are gone, so an empty `deleted` list cannot pass.
      expect(f.realm?.deleted.length).toBeGreaterThan(2)
      for (const path of f.realm?.deleted ?? []) expect(readReal(path), path).toBeUndefined()
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

  it('fails a switch key the ledger does not list', () => {
    const read = tree({
      [entry.ts.file]:
        'export interface LayoutCore { readonly impl: { readonly routeLayout: string; readonly other: string } }\nexport function routeLayout() {}\n',
    })
    expect(checkPortedFunctions([entry], read)).toEqual([
      expect.stringContaining('switch key other is not in PORTED_FUNCTIONS'),
    ])
  })

  it('fails a ledger entry whose switch key is gone', () => {
    const read = tree({
      [entry.ts.file]:
        'export interface LayoutCore { readonly impl: { readonly x: string } }\nexport function routeLayout() {}\n',
    })
    expect(checkPortedFunctions([entry], read)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('has no switch key routeLayout'),
        expect.stringContaining('switch key x is not in PORTED_FUNCTIONS'),
      ]),
    )
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

  describe('a realm dispatcher at stage 4', () => {
    const realm: PortedFunction = {
      ...entry,
      stage: 4,
      switch: undefined,
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
