/**
 * What survives the store, and what a hit is allowed to be.
 *
 * The round trip here is the real one — `JSON.parse(JSON.stringify(…))` is
 * exactly what `render-store.ts` does — because the defect these cases exist
 * for is invisible to any test that hands the decoder an object it built
 * itself.
 */
import { describe, expect, it } from 'vitest'
import { decodeStoredReply, encodeStoredReply } from './layout-worker-stored-reply.js'

const BOUNDS = { x: 0, y: 0, w: 100, h: 50 }

function throughTheStore(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

describe('a laid-out reply through the store', () => {
  const anchors = new Map([['edge-1', { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }]])
  const reply = {
    type: 'laid-out' as const,
    id: 7,
    svg: '<svg/>',
    bounds: BOUNDS,
    scene: { nodes: [] },
    anchors,
  }

  it('keeps its anchors, which a spread would have lost', () => {
    // The whole point: `JSON.stringify(new Map([...]))` is `{}`, so an entry
    // written by spreading the live reply comes back claiming to be a
    // `laid-out` whose anchors are an empty object.
    expect(throughTheStore({ ...reply, id: undefined })).toMatchObject({ anchors: {} })

    const decoded = decodeStoredReply(throughTheStore(encodeStoredReply(reply)))

    const anchorsBack = decoded?.anchors as Map<string, unknown> | undefined
    expect(anchorsBack).toBeInstanceOf(Map)
    expect(anchorsBack?.get('edge-1')).toEqual({
      from: { x: 1, y: 2 },
      to: { x: 3, y: 4 },
    })
  })

  it('carries no id, because an id belongs to a request and not to a picture', () => {
    const decoded = decodeStoredReply(throughTheStore(encodeStoredReply(reply)))

    expect(decoded).not.toHaveProperty('id')
    expect(decoded).toMatchObject({ type: 'laid-out', svg: '<svg/>', bounds: BOUNDS })
  })

  it('keeps the fonts a layout could not measure', () => {
    const decoded = decodeStoredReply(
      throughTheStore(encodeStoredReply({ ...reply, fontsMissing: ['Kiwi Maru'] })),
    )

    expect(decoded).toMatchObject({ fontsMissing: ['Kiwi Maru'] })
  })
})

describe('an entry this build cannot use', () => {
  it('is a miss rather than a reply, when it is not a reply shape at all', () => {
    expect(decodeStoredReply(null)).toBeNull()
    expect(decodeStoredReply('a string')).toBeNull()
    expect(decodeStoredReply({ type: 'laid-out' })).toBeNull()
  })

  it('is a miss when an older build wrote a shape this one reads differently', () => {
    // The anchors-as-object entry above, which is what every `laid-out` entry
    // written before this module looks like.
    const fromTheOldBuild = throughTheStore({
      type: 'laid-out',
      svg: '<svg/>',
      bounds: BOUNDS,
      scene: {},
      anchors: new Map([['edge-1', {}]]),
    })

    expect(decodeStoredReply(fromTheOldBuild)).toBeNull()
  })

  it('is a miss for a type this worker does not reply with', () => {
    expect(decodeStoredReply({ type: 'something-else', svg: '<svg/>' })).toBeNull()
  })

  it('is a miss when a field a consumer reads is the wrong type', () => {
    expect(decodeStoredReply({ type: 'markdown-render-done', svg: 42, bounds: BOUNDS })).toBeNull()
    expect(
      decodeStoredReply({ type: 'markdown-render-done', svg: '<svg/>', bounds: { x: 'a' } }),
    ).toBeNull()
  })
})

describe('the other stored kinds', () => {
  it('round-trips an outline', () => {
    const decoded = decodeStoredReply(
      throughTheStore(
        encodeStoredReply({
          type: 'outlined',
          id: 3,
          rects: [{ x: 0, y: 0, w: 4, h: 4, color: '#fff' }],
        }),
      ),
    )

    expect(decoded).toMatchObject({ type: 'outlined' })
    expect((decoded?.rects as unknown[] | undefined)?.length).toBe(1)
  })

  it('round-trips a markdown render', () => {
    const decoded = decodeStoredReply(
      throughTheStore(
        encodeStoredReply({ type: 'markdown-render-done', id: 9, svg: '<svg/>', bounds: BOUNDS }),
      ),
    )

    expect(decoded).toMatchObject({ type: 'markdown-render-done', svg: '<svg/>' })
  })

  // A field a LATER build adds must not turn this build's hits into misses:
  // both builds' entries sit in the same origin's OPFS until a build sweep
  // retires the old directory.
  it('admits a field this build does not read', () => {
    const decoded = decodeStoredReply({
      type: 'markdown-render-done',
      svg: '<svg/>',
      bounds: BOUNDS,
      somethingLater: { whatever: true },
    })

    expect(decoded).toMatchObject({ type: 'markdown-render-done' })
  })
})
