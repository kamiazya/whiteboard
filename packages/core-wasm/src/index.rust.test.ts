import { readFileSync } from 'node:fs'
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import {
  abi_version,
  edge_route_layout,
  initSync,
  json_canvas_parse,
  json_canvas_serialize,
  okf_parse,
  okf_serialize,
} from '#glue'
import { loadCore } from './load.js'
import type { RoutingBudget } from './types.js'

/**
 * The shim over the artifact `stage:wasm` copied into artifacts/: it loads
 * from bytes and from a compiled module, agrees with the artifact on the
 * ABI, and calls nothing the artifact does not export. What it routes is
 * held to the TypeScript composer by canvas-render's route-layout
 * differential, which goes through this shim.
 */

// Built, not committed: a name the relative-import scan reads as a file that
// must exist would fail every job that has no wasm build.
const WASM = 'whiteboard_wasm_bg.wasm'
const bytes = () => readFileSync(new URL(`../artifacts/${WASM}`, import.meta.url))
const box = (id: string, x: number): SpatialNode =>
  ({ id, type: 'text', text: '', x, y: 0, width: 100, height: 50 }) as SpatialNode
const budget = (): RoutingBudget => ({ grid: 1e6, pairs: 1e6, trials: 1e6, repairs: 1e6 })

describe('the core-wasm shim over the built artifact', () => {
  it('declares only exports the artifact has', () => {
    expect(
      [
        initSync,
        abi_version,
        edge_route_layout,
        okf_parse,
        okf_serialize,
        json_canvas_parse,
        json_canvas_serialize,
      ].map((f) => typeof f),
    ).toEqual(Array(7).fill('function'))
  })

  it('routes a layout from the bytes, and again from a compiled module', async () => {
    for (const source of [bytes(), new WebAssembly.Module(bytes())]) {
      const core = await loadCore(source)
      const b = budget()
      const { routes, anchors } = core.routeLayout(
        [box('a', 0), box('b', 300)],
        [{ id: 'e', from: { node: 'a' }, to: { node: 'b' } }],
        () => 'orthogonal',
        undefined,
        b,
        [],
      )
      const [route] = routes
      expect(route?.path.at(0)?.x).toBe(100)
      expect(route?.path.at(-1)?.x).toBe(300)
      expect(route?.fromSide).toBe('right')
      expect(route?.toSide).toBe('left')
      expect(anchors.get('e')).toMatchObject({ fromSide: 'right', toSide: 'left' })
      // A clean pair needs no trial: the search short-circuits.
      expect(b).toEqual(budget())
    }
  })

  it('reads and writes an OKF document, the body never crossing', async () => {
    const core = await loadCore(bytes())
    const text = '---\ntype: note\ntags:\n  - a\n---\n\u{1F600} body'
    const read = core.parseOkf(text)
    expect(read).toEqual({
      ok: true,
      value: { frontmatter: { type: 'note', tags: ['a'] }, body: '\u{1F600} body' },
    })
    if (!read.ok) return
    expect(core.serializeOkf(read.value)).toBe(text)
  })

  it('reads and writes a JSON Canvas document through the artifact', async () => {
    const core = await loadCore(bytes())
    const text =
      '{"nodes":[{"id":"a","x":0,"y":0,"width":10,"height":10,"type":"text","text":"hi"}],"edges":[]}'
    const read = core.parseSpatial(text)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value.nodes[0]).toMatchObject({ id: 'a', x: 0, width: 10 })
    expect(core.serializeSpatial(read.value, 'strict')).toBe(text)
    expect(core.parseSpatial('{')).toMatchObject({ ok: false, error: { stage: 'json-syntax' } })
  })

  it('counts a lone surrogate it is sent as one unit, and refuses one the mark stands for', () => {
    // wasm-bindgen encodes a lone surrogate as U+FFFD, which is one UTF-16 unit
    // to the artifact as the surrogate was, so an offset it answers still
    // indexes the host's string.
    const comment = '---\ntype: x # \ud800\n---\n'
    expect(JSON.parse(okf_parse(comment, 0))).toEqual(['ok', comment.length, ['m', 'type', 'x']])
    const value = '---\ntype: a\ue000\n---\n'
    expect(JSON.parse(okf_parse(value, 0xe000))).toEqual(['err', 'yaml', 'subset', []])
    expect(JSON.parse(okf_parse(value, 0))[0]).toBe('ok')
  })
})
