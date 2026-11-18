import { readFileSync } from 'node:fs'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { decodeLines, type SvgRecord } from '../test-utils/render-oracle/oracle.js'

/**
 * The committed recording of what the TypeScript SVG backend (deleted, ADR-0054
 * A3.6) answered for a scene, whole and keyed, over the envelope options a
 * caller may pass. The Rust SVG backend replays it natively and on wasm32
 * (`crates/core/canvas-render/tests/svg_oracle.rs`) and is held to it byte for
 * byte.
 *
 * The scenes are the pixel and determinism goldens, the pixel goldens as the
 * browser screenshots them (`pixel-mount/`), and the scenes the render
 * recording laid out when it was taken. It is FROZEN: the laid-out scenes are
 * recorded inputs now, not what today's layout draws, so nothing re-records
 * it (ADR-0054 A3.6).
 */
const FILE = new URL('./svg.jsonl', import.meta.url)

describe('the recorded SVG backend oracle', () => {
  const text = readFileSync(FILE, 'utf8')
  const recorded = decodeLines<SvgRecord>(text)

  it('reaches the goldens, the laid-out scenes and every envelope option', () => {
    const under = (prefix: string) => recorded.filter((r) => r.id.startsWith(prefix)).length
    expect(under('golden/'), 'determinism goldens').toBeGreaterThan(6)
    expect(under('pixel/'), 'pixel goldens').toBeGreaterThan(30)
    expect(under('layout/'), 'laid-out scenes').toBeGreaterThan(100)
    expect(under('pixel-mount/'), 'pixel goldens as mounted').toBe(8)
    expect(recorded.filter((r) => r.id.startsWith('golden/every-kind')).length, 'every kind').toBe(
      4,
    )
    for (const option of ['padding', 'background', 'width', 'textFill', 'viewBox', 'legend']) {
      expect(
        recorded.filter((r) => r.options !== null && option in r.options).length,
        `scenes drawn with ${option}`,
      ).toBeGreaterThan(5)
    }
  })
})

/**
 * The pixel goldens' two hard constraints, held on the recorded scenes they
 * paint: text-free (a glyph would make a baseline a claim about the machine's
 * fonts) and, for the hand-authored ones, integer-aligned (what keeps every
 * derived point - arrow wings, jump entry/exit, rounded corners - off a
 * sub-pixel boundary). Allowlist, not a denylist: 'edge' and 'shape' are the
 * only kinds that carry no text.
 */
const GEOMETRY_ONLY_KINDS: readonly SceneNode['kind'][] = ['edge', 'shape']
const INTEGER_ALIGNED = ['jump-hop', 'rounded-corners', 'arrowheads', 'rounded-rect']
// The icon set draws icons and the node outlines are laid out, so neither is held to either.
const TEXT_FREE = [...INTEGER_ALIGNED, 'sketch-look', 'neon-look']

function coordinatesOf(node: SceneNode): number[] {
  if (node.kind === 'edge') {
    return [
      ...node.path.flatMap((p) => [p.x, p.y]),
      ...(node.jumps ?? []).flatMap((j) => [j.x, j.y]),
    ]
  }
  if (node.kind === 'shape') {
    return [
      node.bbox.x,
      node.bbox.y,
      node.bbox.w,
      node.bbox.h,
      ...(node.radius === undefined ? [] : [node.radius]),
    ]
  }
  return []
}

describe('the recorded pixel goldens stay text-free and integer-aligned', () => {
  const recorded = decodeLines<SvgRecord>(readFileSync(FILE, 'utf8'))
  const pixel = recorded.filter((r) => /^pixel\/[^#]+#0$/.test(r.id))
  const textFree = pixel.filter((r) => TEXT_FREE.some((n) => r.id === `pixel/${n}#0`))

  it('records every golden the browser screenshots', () => {
    expect(pixel.length).toBe(8)
    expect(textFree.length).toBe(6)
  })

  it.each(
    textFree.map((r) => [r.id, r] as const),
  )('%s contains only geometry-only node kinds', (_id, r) => {
    // A count, so an empty scene cannot pass this vacuously.
    expect(r.scene.nodes.length).toBeGreaterThan(0)
    for (const node of r.scene.nodes) expect(GEOMETRY_ONLY_KINDS).toContain(node.kind)
  })

  it.each(
    pixel
      .filter((r) => INTEGER_ALIGNED.some((n) => r.id === `pixel/${n}#0`))
      .map((r) => [r.id, r] as const),
  )('%s uses only integer coordinates', (_id, r) => {
    for (const node of r.scene.nodes) {
      for (const value of coordinatesOf(node)) expect(Number.isInteger(value)).toBe(true)
    }
  })
})
