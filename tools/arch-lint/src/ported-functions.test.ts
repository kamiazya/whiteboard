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
  it('lists the edge-routing function and the real tree agrees with it', () => {
    expect(PORTED_FUNCTIONS.map((f) => f.name)).toContain('routeLayout')
    expect(checkPortedFunctions(PORTED_FUNCTIONS, readReal)).toEqual([])
  })

  it('reads the real switch keys, so an empty read cannot pass for agreement', () => {
    const keys = switchKeys(readReal(entry.switch.file) as string, entry.switch.interface)
    expect(keys).toEqual(['routeLayout'])
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
})
