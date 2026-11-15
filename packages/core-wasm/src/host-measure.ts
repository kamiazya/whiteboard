// The host's own measurer, which a layout naming `{kind: 'host'}` asks
// mid-layout through the core's one import (ADR-0054 step 7, owner decision
// q77): the browser measures with a canvas context nothing in the core
// repeats. Typed structurally, as canvas-render's `MeasureText`, since this
// package may not import canvas-render.

/** A font as canvas-render's `FontDescriptor` names it. */
export interface HostFont {
  readonly family: string
  readonly fallbackChain: readonly string[]
  readonly weight: number
  readonly style: 'normal' | 'italic'
  readonly sizePx: number
}

/** canvas-render's `MeasureText`. */
export type HostMeasure = (
  text: string,
  font: HostFont,
) => {
  readonly advanceWidth: number
  readonly ascent: number
  readonly descent: number
  readonly lineGap: number
}

/** What the core's import calls: four numbers for a text in the font a key names. */
export interface HostMeasurer {
  measure(text: string, fontKey: string): number[]
}

/** The font a key spells: `[family, fallbackChain, weight, style, sizePx]`. */
function fontOf(key: string): HostFont {
  const [family, fallbackChain, weight, style, sizePx] = JSON.parse(key) as [
    string,
    string[],
    number,
    HostFont['style'],
    number,
  ]
  return { family, fallbackChain, weight, style, sizePx }
}

const HOSTS = new WeakMap<HostMeasure, HostMeasurer>()

/**
 * `measure` as the object the core's import calls, one per measurer: each
 * font key is read once for the measurer's life, since a layout asks in runs
 * of a handful of fonts.
 */
export function hostMeasurerOf(measure: HostMeasure): HostMeasurer {
  const held = HOSTS.get(measure)
  if (held !== undefined) return held
  const fonts = new Map<string, HostFont>()
  const host: HostMeasurer = {
    measure(text, key) {
      let font = fonts.get(key)
      if (font === undefined) {
        font = fontOf(key)
        fonts.set(key, font)
      }
      const metrics = measure(text, font)
      return [metrics.advanceWidth, metrics.ascent, metrics.descent, metrics.lineGap]
    },
  }
  HOSTS.set(measure, host)
  return host
}
