import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { LayoutFaces } from './font-handles.js'
import {
  type CoreGlue,
  CoreHandleLost,
  CoreInstanceTrapped,
  coreFrom,
  EXPECTED_ABI,
  ORACLE_ABI,
} from './index.js'
import { recoverable } from './recover.js'

/**
 * A panic aborts the wasm instance (`panic = "abort"`), and plain `initSync`
 * keeps returning the dead one. This runs the poison-and-recover scenario
 * through the real `Core` over the oracle artifact, which carries the
 * deliberate trap: the trapped call is refused, the next call is answered by a
 * fresh instance behind the same `Core`, and what the old instance held is
 * refused by name instead of read from whatever now holds its number.
 */

const dir = process.env.WHITEBOARD_WASM_DIR ?? ''
const shippedWasm = new URL('../artifacts/whiteboard_wasm_bg.wasm', import.meta.url)

interface OracleGlue {
  initSync(init: { module: BufferSource }): unknown
  abi_version(): string
  poison_instance(): void
  register_layout_fonts(bytes: Uint8Array, faces: string): string
  __wbg_reset_state(): void
}

// Joined by segment, not written as a relative path: a test may read a font
// another package ships, and this is a file read, not an import.
const roboto = () =>
  readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      'mcp-server',
      'assets',
      'fonts',
      'Roboto',
      'Roboto-Regular.ttf',
    ),
  )

async function load() {
  const module = await import(pathToFileURL(join(dir, 'whiteboard_wasm.js')).href)
  const wasm = readFileSync(join(dir, 'whiteboard_wasm_bg.wasm'))
  const registrations: number[] = []
  // A copy, so the registration of faces can be counted: the glue's functions
  // are standalone, and the shim guards whatever object it is given.
  const raw = {
    ...(module as OracleGlue),
    register_layout_fonts(bytes: Uint8Array, faces: string) {
      registrations.push(bytes.byteLength)
      return (module as OracleGlue).register_layout_fonts(bytes, faces)
    },
  }
  const glue = raw as unknown as CoreGlue
  return {
    raw,
    registrations,
    core: coreFrom(glue, wasm),
    poison: () => (recoverable(raw, ORACLE_ABI) as OracleGlue).poison_instance(),
    exports: () => raw.initSync({ module: wasm }),
  }
}

const note = (measure: LayoutFaces | { kind: 'fake'; factor: number }) =>
  ({ kind: 'markdown', body: 'Hello **world**', maxWidth: 300, measure, mode: 'light' }) as const

describe('recovering a wasm instance a panic aborted', () => {
  it('refuses the trapped call, answers the next from a fresh instance and voids the old handles', async () => {
    const { raw, core, poison, exports, registrations } = await load()
    expect(raw.abi_version()).toBe(ORACLE_ABI)
    expect(ORACLE_ABI).toBe(`${EXPECTED_ABI}+oracle-surface`)
    const before = exports()

    const faces: LayoutFaces = {
      kind: 'fonts',
      faces: [{ family: 'Roboto', bold: false, italic: false, bytes: roboto() }],
    }
    const index = core.search.createIndex()
    index.upsert({ documentId: 'a', path: 'a.md', texts: ['hello world'] })
    expect(index.search('hello').map((hit) => hit.documentId)).toEqual(['a'])
    expect('scene' in core.layoutMarkdown(note(faces))).toBe(true)
    expect(registrations).toHaveLength(1)

    expect(poison).toThrow(CoreInstanceTrapped)
    expect(exports(), 'a new instance, not the aborted one').not.toBe(before)

    expect(core.search.foldForSearch('Café')).toBe('cafe')
    expect('scene' in core.layoutMarkdown(note({ kind: 'fake', factor: 0.6 }))).toBe(true)

    // The old index's number is the new instance's first handle: only the
    // generation tells them apart.
    const fresh = core.search.createIndex()
    expect(fresh.size().documents).toBe(0)
    expect(() => index.search('hello')).toThrow(CoreHandleLost)
    expect(() => index.upsert({ documentId: 'b', path: 'b.md', texts: [] })).toThrow(CoreHandleLost)

    expect('scene' in core.layoutMarkdown(note(faces)), 'fonts work again').toBe(true)
    expect(registrations, 'registered afresh, once').toHaveLength(2)
    expect('scene' in core.layoutMarkdown(note(faces))).toBe(true)
    expect(registrations).toHaveLength(2)
  })

  it('recovers from a second trap on the fresh instance', async () => {
    const { core, poison } = await load()
    expect(poison).toThrow(CoreInstanceTrapped)
    expect(poison).toThrow(CoreInstanceTrapped)
    expect(core.search.foldForSearch('A')).toBe('a')
  })

  it('leaves the deliberate trap out of the shipped artifact, which can still be reset', () => {
    const names = WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(shippedWasm))).map(
      (e) => e.name,
    )
    expect(names).toContain('abi_version')
    expect(names).not.toContain('poison_instance')
    const glue = readFileSync(new URL('../artifacts/whiteboard_wasm.js', import.meta.url), 'utf8')
    expect(glue).toContain('__wbg_reset_state')
  })
})
