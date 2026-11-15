import { describe, expect, it } from 'vitest'
import { FenceTokenMemo } from './fence-tokens.js'
import { FontHandles } from './font-handles.js'
import { type HostFont, type HostMeasure, hostMeasurerOf } from './host-measure.js'
import { type LayoutGlue, type LayoutRequest, layoutSpatialCanvas } from './layout.js'

const errors = {
  refused: (operation: string, code: string, detail?: string) =>
    new Error(`${operation} ${code} ${detail ?? ''}`),
}

/** A measurer keeping every font it was handed. */
function recording() {
  const fonts: HostFont[] = []
  const measure: HostMeasure = (text, font) => {
    fonts.push(font)
    return { advanceWidth: text.length, ascent: 2, descent: 3, lineGap: 4 }
  }
  return { measure, fonts }
}

/** A glue that asks the host it is handed to measure `text` in `key`, as the core's import does. */
function askingGlue(text: string, key: string) {
  const answers: unknown[] = []
  const glue: LayoutGlue = {
    layout_spatial_canvas(_request, host) {
      answers.push(host === undefined ? 'no host' : host.measure(text, key))
      return '["declined","x"]'
    },
    register_layout_fonts: () => '["ok",1]',
    release_layout_fonts: () => true,
  }
  return { glue, answers }
}

const lay = (glue: LayoutGlue, request: LayoutRequest, measure?: HostMeasure) =>
  layoutSpatialCanvas(
    glue,
    errors,
    request,
    undefined,
    new FenceTokenMemo(),
    new FontHandles(glue, errors),
    measure,
  )

const KEY = '["Roboto",["Noto Sans","sans-serif"],600,"italic",14.5]'

describe('the host measurer the core asks mid-layout', () => {
  it('reads a font key back as the font it names, and answers its four numbers', () => {
    const { measure, fonts } = recording()
    expect(hostMeasurerOf(measure).measure('word', KEY)).toEqual([4, 2, 3, 4])
    expect(fonts).toEqual([
      {
        family: 'Roboto',
        fallbackChain: ['Noto Sans', 'sans-serif'],
        weight: 600,
        style: 'italic',
        sizePx: 14.5,
      },
    ])
  })

  it('is one object per measurer, reading each key once', () => {
    const { measure, fonts } = recording()
    const host = hostMeasurerOf(measure)
    expect(hostMeasurerOf(measure)).toBe(host)
    host.measure('a', KEY)
    host.measure('b', KEY)
    expect(fonts[1]).toBe(fonts[0])
    expect(hostMeasurerOf(recording().measure)).not.toBe(host)
  })

  it('is handed to the core only for a request that names it, and only when given', () => {
    const { measure } = recording()
    const host = askingGlue('abc', KEY)
    lay(host.glue, { measure: { kind: 'host' } }, measure)
    lay(host.glue, { measure: { kind: 'host' } })
    lay(host.glue, { measure: { kind: 'ratio' } }, measure)
    expect(host.answers).toEqual([[3, 2, 3, 4], 'no host', 'no host'])
  })
})
