import { describe, expect, it } from 'vitest'
import { type Finalizer, FontHandles, type FontsGlue } from './font-handles.js'
import { REGISTER_LAYOUT_FONTS_CAPS } from './generated/input-caps.js'
import { type LayoutGlue, type LayoutRequest, layoutSpatialCanvas } from './layout.js'

const errors = {
  refused: (operation: string, code: string, detail?: string) =>
    new Error(`${operation} ${code} ${detail ?? ''}`),
}

const OK = '["ok",{"nodes":[]},[],[]]'
const LOST = '["refused","malformed","font-handle"]'

/**
 * A glue whose registrations answer handles 7, 8, ... and whose layouts
 * answer `answers` in turn, keeping every call.
 */
function glueOf(...answers: string[]) {
  const registered: { bytes: number[]; faces: unknown }[] = []
  const released: number[] = []
  const handles: unknown[] = []
  const glue: LayoutGlue & FontsGlue = {
    register_layout_fonts(bytes, faces) {
      registered.push({ bytes: [...bytes], faces: JSON.parse(faces) })
      return `["ok",${6 + registered.length}]`
    },
    release_layout_fonts(handle) {
      released.push(handle)
      return true
    },
    layout_spatial_canvas(request) {
      const wire = JSON.parse(request) as unknown[]
      const measure = wire[wire.indexOf('measure') + 1] as unknown[]
      handles.push(measure[measure.indexOf('handle') + 1])
      return answers[handles.length - 1] ?? OK
    },
  }
  return { glue, registered, released, handles }
}

/** A finalizer that collects only when told to, keeping every registration as `FinalizationRegistry` does. */
function finalizerOf() {
  let watched: { token: object; handle: number }[] = []
  let release: (handle: number) => void = () => undefined
  const make = (onCollect: (handle: number) => void): Finalizer => {
    release = onCollect
    return {
      register: (_target, handle, token) => void watched.push({ token, handle }),
      unregister: (token) => {
        watched = watched.filter((entry) => entry.token !== token)
      },
    }
  }
  const collect = (token: object) => {
    for (const entry of watched) if (entry.token === token) release(entry.handle)
    watched = watched.filter((entry) => entry.token !== token)
  }
  return { make, handles: () => watched.map((entry) => entry.handle), collect }
}

const facesOf = () =>
  ({
    kind: 'fonts',
    faces: [
      { family: 'A', bold: false, italic: false, bytes: new Uint8Array([1, 2]) },
      { family: 'A', bold: true, italic: true, bytes: new Uint8Array([3, 4, 5]) },
    ],
  }) as const

describe('the faces a font-table measurer reads', () => {
  it('are registered once per measurer, as one array they point into, and named by handle', () => {
    const { glue, registered, handles } = glueOf()
    const fonts = new FontHandles(glue, errors)
    const request = { measure: facesOf() } as LayoutRequest
    layoutSpatialCanvas(glue, errors, request, undefined, undefined, fonts)
    layoutSpatialCanvas(glue, errors, request, undefined, undefined, fonts)
    expect(registered).toEqual([
      {
        bytes: [1, 2, 3, 4, 5],
        faces: [
          's',
          ['m', 'family', 'A', 'bold', false, 'italic', false, 'from', 0, 'to', 2],
          ['m', 'family', 'A', 'bold', true, 'italic', true, 'from', 2, 'to', 5],
        ],
      },
    ])
    expect(handles).toEqual([7, 7])
    layoutSpatialCanvas(glue, errors, { measure: facesOf() }, undefined, undefined, fonts)
    expect(registered, 'another measurer registers its own').toHaveLength(2)
    expect(handles[2]).toBe(8)
  })

  it('are registered again, and the layout asked once more, when the core lost the handle', () => {
    const { glue, registered, handles } = glueOf(OK, LOST, OK)
    const fonts = new FontHandles(glue, errors)
    const request = { measure: facesOf() } as LayoutRequest
    layoutSpatialCanvas(glue, errors, request, undefined, undefined, fonts)
    const answer = layoutSpatialCanvas(glue, errors, request, undefined, undefined, fonts)
    expect(answer).toEqual({ scene: { nodes: [] }, anchors: new Map(), degradations: [] })
    expect(registered).toHaveLength(2)
    expect(handles).toEqual([7, 7, 8])
    layoutSpatialCanvas(glue, errors, request, undefined, undefined, fonts)
    expect(handles[3]).toBe(8)
  })

  it('refuse a layout whose fresh handle is lost too, rather than registering without end', () => {
    const { glue, registered } = glueOf(LOST, LOST, OK)
    const fonts = new FontHandles(glue, errors)
    const request = { measure: facesOf() } as LayoutRequest
    expect(() => layoutSpatialCanvas(glue, errors, request, undefined, undefined, fonts)).toThrow(
      'layout_spatial_canvas malformed font-handle',
    )
    expect(registered).toHaveLength(2)
  })

  it('decline a layout past the caps of a registration, and throw on faces that are no fonts', () => {
    const refusing = (answer: string) => ({
      ...glueOf().glue,
      register_layout_fonts: () => answer,
    })
    const request = { measure: facesOf() } as LayoutRequest
    const full = refusing('["refused","input-too-large","held"]')
    expect(
      layoutSpatialCanvas(
        full,
        errors,
        request,
        undefined,
        undefined,
        new FontHandles(full, errors),
      ),
    ).toEqual({
      declined: 'held',
    })
    const bad = refusing('["refused","malformed","font"]')
    expect(() =>
      layoutSpatialCanvas(bad, errors, request, undefined, undefined, new FontHandles(bad, errors)),
    ).toThrow('register_layout_fonts malformed font')
    const garbled = refusing('["ok","7"]')
    expect(() =>
      layoutSpatialCanvas(
        garbled,
        errors,
        request,
        undefined,
        undefined,
        new FontHandles(garbled, errors),
      ),
    ).toThrow('register_layout_fonts malformed answer')
    const { glue, registered } = glueOf()
    const big = new Uint8Array(REGISTER_LAYOUT_FONTS_CAPS.maxBytes)
    const huge = {
      measure: { kind: 'fonts', faces: [{ family: 'A', bold: false, italic: false, bytes: big }] },
    }
    expect(
      layoutSpatialCanvas(
        glue,
        errors,
        huge as LayoutRequest,
        undefined,
        undefined,
        new FontHandles(glue, errors),
      ),
    ).toEqual({
      declined: 'too-large',
    })
    expect(registered).toEqual([])
  })

  it('are the handles a caller holds, never a cache one layout makes for itself', () => {
    const { glue } = glueOf()
    // @ts-expect-error a cache made per call would register a retained measurer's faces on every layout
    const unheld = () => layoutSpatialCanvas(glue, errors, { measure: facesOf() })
    expect(unheld).toBeTypeOf('function')
  })

  it('decline faces whose lengths add up past the cap before copying them', () => {
    const { glue, registered } = glueOf()
    const shared = new Uint8Array(REGISTER_LAYOUT_FONTS_CAPS.maxBytes / 2)
    const face = { family: 'A', bold: false, italic: false, bytes: shared }
    // 128 GiB summed: a copy sized before the cap is checked cannot be allocated at all.
    const faces = { kind: 'fonts', faces: Array.from({ length: 4096 }, () => face) } as const
    expect(new FontHandles(glue, errors).handleOf(faces)).toEqual({ declined: 'too-large' })
    expect(registered).toEqual([])
  })

  it('are released once the measurer naming them is collected, and not when it was lost', () => {
    const { glue, released } = glueOf(OK, LOST, OK)
    const finalizer = finalizerOf()
    const fonts = new FontHandles(glue, errors, finalizer.make)
    const kept = facesOf()
    layoutSpatialCanvas(glue, errors, { measure: kept }, undefined, undefined, fonts)
    expect(finalizer.handles()).toEqual([7])
    layoutSpatialCanvas(glue, errors, { measure: kept }, undefined, undefined, fonts)
    expect(finalizer.handles(), 'the lost handle is no longer watched').toEqual([8])
    finalizer.collect(kept)
    expect(released).toEqual([8])
  })
})
