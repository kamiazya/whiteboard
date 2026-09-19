/**
 * An inline `![](...)` in a body draws as the IMAGE, not as its alt words.
 *
 * The layout's inline vocabulary is text runs, and it was so closed that an
 * image had nowhere to go: `case 'image'` emitted `child.alt ?? ''`, so
 * `![a diagram](x.png)` came out as the words "a diagram". No rationale for
 * that was written anywhere — it is what falls out of a closed type rather
 * than a decision someone recorded — while a BLOCK image (a resolved embed)
 * has been fully supported all along.
 *
 * The run stays a run. `text` remains the alt, which is what everything
 * except the painter depends on: passage anchoring matches the same quotes,
 * the outline reads the same words, and a surface that has not heard of
 * `paints` renders exactly what it rendered before.
 */
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { passageBoxes } from '../passage-highlight.js'
import { layoutMdastBlocks } from './mdast-blocks.js'

const options = { measure: createFakeMeasure(), maxWidth: 600, fontFamily: 'sans-serif' }

const runsOf = (root: MdastRoot) =>
  layoutMdastBlocks(root, options).nodes.flatMap((node) =>
    'runs' in node ? [...(node.runs ?? [])] : [],
  )

/** A paragraph of `children`, as mdast. */
const paragraph = (children: MdastRoot['children'][number] extends never ? never : object[]) =>
  ({ type: 'root', children: [{ type: 'paragraph', children }] }) as unknown as MdastRoot

describe('an inline image is painted, and still reads as its alt', () => {
  it('marks the run to paint the image, and keeps the alt as its text', () => {
    const runs = runsOf(
      paragraph([
        { type: 'text', value: 'see ' },
        { type: 'image', url: 'diagram.png', alt: 'a diagram' },
        { type: 'text', value: ' here' },
      ]),
    )
    const image = runs.find((run) => run.paints !== undefined)
    expect(image?.paints).toEqual({ kind: 'image', src: 'diagram.png' })
    // The alt survives as the run's text — this is the whole contract with
    // passage anchoring and the outline, both of which read `text`.
    expect(image?.text).toBe('a diagram')
    // Joined with a space: layout puts the gap between two words in an x
    // offset rather than in a string, so joining raw yields 'seea diagramhere'.
    expect(runs.map((run) => run.text).join(' ')).toBe('see a diagram here')
  })

  /**
   * An image with no alt has nothing to read as, and the run's box still
   * has to exist or the picture has nowhere to go — so it takes a
   * placeholder rather than an empty string, which would measure to zero
   * width and paint the image into nothing.
   */
  it('still occupies a box when the image has no alt', () => {
    const runs = runsOf(paragraph([{ type: 'image', url: 'x.png' }]))
    const image = runs.find((run) => run.paints !== undefined)
    expect(image?.paints).toEqual({ kind: 'image', src: 'x.png' })
    // `w`, not `width` — the scene's BoundingBox spells it short.
    expect(image?.bbox.w).toBeGreaterThan(0)
    expect(image?.text).not.toBe('')
  })

  /** A plain text run is untouched — `paints` is absent, not a falsy value. */
  it('leaves ordinary prose alone', () => {
    const runs = runsOf(paragraph([{ type: 'text', value: 'just words' }]))
    expect(runs.every((run) => run.paints === undefined)).toBe(true)
  })
})

/**
 * The contract this whole design exists to keep, pinned rather than
 * inferred from "the other tests still pass".
 *
 * A comment's passage is anchored by matching its quote against the runs
 * read as ONE STRING (`renderedTextOf`). Had an inline image become a scene
 * node of its own with no `text`, a quote spanning it would have found
 * nothing — a comment silently losing its highlight, on a feature nobody
 * would think to re-check while adding pictures. Because the run keeps the
 * alt as its text, the quote matches exactly as it did before.
 */
describe('a comment can still be anchored across an inline image', () => {
  it('finds a passage whose quote spans the image', () => {
    const runs = runsOf(
      paragraph([
        { type: 'text', value: 'see ' },
        { type: 'image', url: 'diagram.png', alt: 'a diagram' },
        { type: 'text', value: ' here' },
      ]),
    )
    const boxes = passageBoxes(runs, { exact: 'see a diagram here' }, options.measure)
    expect(boxes.length).toBeGreaterThan(0)
  })

  it('finds one that stops at the image', () => {
    const runs = runsOf(
      paragraph([
        { type: 'text', value: 'see ' },
        { type: 'image', url: 'diagram.png', alt: 'a diagram' },
      ]),
    )
    expect(passageBoxes(runs, { exact: 'a diagram' }, options.measure).length).toBeGreaterThan(0)
  })
})

/**
 * The URL a picture actually loads from is the CALLER's to decide, the same
 * way a file node's is. Shipped without this, an inline image drew whatever
 * the markdown said — so an absolute URL worked and a relative path or a
 * workspace attachment did not, which is most of them.
 *
 * No new seam: `resolveReference` is one of the four `referenceSeams`
 * produces, and `MdastLayoutOptions` already carries the whole bundle
 * (a canvas embedded in a note has file nodes that read it). The inline
 * image case just stops being the one thing in a body that never asks.
 */
describe('an inline image asks the caller where its picture is', () => {
  const withSeam = (url: string, href: string | undefined) =>
    layoutMdastBlocks(paragraph([{ type: 'image', url, alt: 'a diagram' }]), {
      ...options,
      references: {
        resolveAlias: () => null,
        resolveTitle: () => undefined,
        resolveEmbed: () => undefined,
        resolveReference: (ref: string) =>
          ref === url && href !== undefined ? { image: { href } } : undefined,
      },
    }).nodes.flatMap((node) => ('runs' in node ? [...(node.runs ?? [])] : []))

  it('paints the resolved href rather than the written path', () => {
    const runs = withSeam('attachments/plan.png', 'blob:local/abc')
    expect(runs.find((run) => run.paints !== undefined)?.paints).toEqual({
      kind: 'image',
      src: 'blob:local/abc',
    })
  })

  /**
   * A reference nothing resolves keeps the written URL rather than drawing
   * nothing: an absolute `https://` one needs no resolution and worked
   * before this, and losing it would be a regression dressed as a feature.
   */
  it('falls back to the written URL when nothing resolves it', () => {
    const runs = withSeam('https://example.com/x.png', undefined)
    expect(runs.find((run) => run.paints !== undefined)?.paints).toEqual({
      kind: 'image',
      src: 'https://example.com/x.png',
    })
  })

  /** A seam that throws is a seam, not a crash — the never-throw rule. */
  it('keeps the written URL when the seam throws', () => {
    const runs = layoutMdastBlocks(paragraph([{ type: 'image', url: 'x.png', alt: 'a' }]), {
      ...options,
      references: {
        resolveAlias: () => null,
        resolveTitle: () => undefined,
        resolveEmbed: () => undefined,
        resolveReference: () => {
          throw new Error('boom')
        },
      },
    }).nodes.flatMap((node) => ('runs' in node ? [...(node.runs ?? [])] : []))
    expect(runs.find((run) => run.paints !== undefined)?.paints).toEqual({
      kind: 'image',
      src: 'x.png',
    })
  })
})
