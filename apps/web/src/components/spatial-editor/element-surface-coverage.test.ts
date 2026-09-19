// @vitest-environment node
/**
 * Every KIND of element a canvas holds, against every editor surface that
 * has to know about it.
 *
 * This exists because of how a whole session's defects actually arrived.
 * `lines` were added to the model and the editor learned about them one
 * surface at a time, each gap found by a person using the product rather
 * than by a test: the press hit-test settled on the node under the stroke,
 * the marquee looked at boxes only, the context menu resolved its target out
 * of `canvas.edges` (so Delete was reachable from the keyboard and nowhere
 * else), and shift-click dropped the selection it was meant to grow. Every
 * one of those passed every suite. Nothing was wrong with any single piece —
 * what was missing was the QUESTION, asked of a new element kind, about each
 * surface in turn.
 *
 * So the key set is derived from the model rather than written here: adding
 * a collection to `SpatialCanvas` makes this table incomplete and the build
 * fails until somebody answers the question for every surface. Removing one
 * fails too, through the same `satisfies`.
 *
 * A `handled` cell names the test that proves it, and the run checks that
 * file EXISTS. A citation nobody reads is not evidence — this repo has
 * already shipped a number with a source named beside it that nothing read.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'

/**
 * Every collection of identified elements the canvas holds, derived so a new
 * one cannot be added without this table noticing. `facets` and `tags` are
 * records rather than arrays of things with ids, so they are not element
 * kinds and do not appear.
 */
type ElementCollection = {
  [K in keyof SpatialCanvas]-?: NonNullable<SpatialCanvas[K]> extends readonly {
    readonly id: string
  }[]
    ? K
    : never
}[keyof SpatialCanvas]

/**
 * The surfaces an element kind has to be answered for. Each one is a place a
 * line was forgotten; the list is the shape of this session's bug report,
 * not a taxonomy invented in advance.
 */
type EditorSurface =
  | 'press'
  | 'shift-press'
  | 'marquee'
  | 'context menu'
  | 'delete'
  | 'lock'
  | 'selection highlight'

/**
 * `handled` names the test file that proves it. `n/a` says the surface has
 * no meaning for this kind. `gap` is a real, known hole — written down
 * rather than discovered again by somebody using the product.
 */
type SurfaceAnswer = `handled: ${string}` | `n/a: ${string}` | `gap: ${string}`

const ELEMENT_SURFACES = {
  nodes: {
    press: 'handled: SpatialEditor.browser.test.tsx',
    'shift-press': 'handled: multi-select.browser.test.tsx',
    marquee: 'handled: multi-select.browser.test.tsx',
    'context menu': 'handled: context-menu.browser.test.tsx',
    delete: 'handled: SpatialEditor.browser.test.tsx',
    lock: 'handled: node-lock.browser.test.tsx',
    'selection highlight': 'handled: multi-select.browser.test.tsx',
  },
  edges: {
    press: 'handled: edge-select-delete.browser.test.tsx',
    'shift-press':
      'gap: shift never adds an edge, in EITHER direction — the shift branch tests `hitId`, which an edge leaves undefined, and shift onto a node drops a held edge (SpatialEditor `toggleSelectionMember`) where it keeps held ink. The difference is the verbs behind the selection: `toggle-lock` dispatches to a single edge, so a surviving one would lock the relation instead of the nodes being gathered. Opening it means giving those verbs a set, which is a product decision nobody has asked for',
    marquee:
      'gap: a band takes nodes and ink, never edges. An edge follows the nodes it connects, so a band over a diagram arguably means the nodes and their relations — but that is a product decision nobody has taken, and taking it silently in a coverage table would be the wrong place for it',
    'context menu': 'handled: context-menu.browser.test.tsx',
    delete: 'handled: edge-select-delete.browser.test.tsx',
    lock: 'handled: edge-lock.browser.test.tsx',
    'selection highlight': 'handled: edge-select-delete.browser.test.tsx',
  },
  lines: {
    press: 'handled: freehand-ink.browser.test.tsx',
    'shift-press': 'handled: freehand-ink.browser.test.tsx',
    marquee: 'handled: freehand-ink.browser.test.tsx',
    'context menu': 'handled: freehand-ink.browser.test.tsx',
    delete: 'handled: freehand-ink.browser.test.tsx',
    lock: 'handled: line-ink.browser.test.tsx',
    'selection highlight': 'handled: freehand-ink.browser.test.tsx',
  },
  comments: {
    press: 'handled: comment-create.browser.test.tsx',
    'shift-press':
      'n/a: a comment is not content (ADR-0024) — it is never part of a selection a verb acts on, so there is nothing for shift to add it to',
    marquee: 'n/a: the same reason — a band gathers content, and a comment is not content',
    'context menu': 'handled: comment-edit.browser.test.tsx',
    delete:
      'n/a: a thread is RESOLVED rather than deleted, and the annotation layer is never tidied (see .claude/rules/vocabulary.md). Its verb is set-comment-resolved',
    lock: 'n/a: the lock is about who may change the document; a comment is beside it',
    'selection highlight': 'n/a: nothing selects a comment, so nothing highlights one',
  },
} satisfies Record<ElementCollection, Record<EditorSurface, SurfaceAnswer>>

/** Every test file beside this one, for checking a citation names a real one. */
const siblings = import.meta.glob('./**/*.test.{ts,tsx}', { query: '?raw', eager: true })
const neighbours = import.meta.glob('../**/*.test.{ts,tsx}', { query: '?raw', eager: true })

describe('every element kind, answered for every editor surface', () => {
  const cells = Object.entries(ELEMENT_SURFACES).flatMap(([collection, surfaces]) =>
    Object.entries(surfaces).map(([surface, answer]) => ({ collection, surface, answer })),
  )

  it('asks the question of every pair', () => {
    // 4 collections x 7 surfaces. A vacuous table is the failure mode a
    // ledger has, so the count is asserted rather than assumed.
    expect(cells).toHaveLength(28)
  })

  it('cites a test file that exists for every handled cell', () => {
    // The half that makes this more than a list of intentions: a `handled`
    // answer names a file, and a file that is not there means the claim was
    // never checked by anything.
    const known = new Set(
      [...Object.keys(siblings), ...Object.keys(neighbours)].map((path) =>
        path.slice(path.lastIndexOf('/') + 1),
      ),
    )
    const missing = cells
      .filter((cell) => cell.answer.startsWith('handled: '))
      .map((cell) => ({ ...cell, file: cell.answer.slice('handled: '.length) }))
      .filter((cell) => !known.has(cell.file))
      .map((cell) => `${cell.collection}/${cell.surface} cites ${cell.file}, which is not there`)
    expect(missing).toEqual([])
  })

  it('gives every gap and exemption a reason worth reading', () => {
    // A bare exemption is the omission with a word in front of it — the same
    // rule `blastRadius: none:` follows.
    const thin = cells
      .filter((cell) => !cell.answer.startsWith('handled: '))
      .filter((cell) => cell.answer.split(': ').slice(1).join(': ').length < 40)
      .map((cell) => `${cell.collection}/${cell.surface}`)
    expect(thin).toEqual([])
  })
})
