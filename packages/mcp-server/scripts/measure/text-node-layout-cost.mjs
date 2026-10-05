/**
 * What laying out ONE text node costs, by the length of its text — the work
 * `wb_canvas_edit` does to size or check a text node before it writes.
 *
 * Run:
 *   node --import tsx/esm scripts/measure/text-node-layout-cost.mjs [lengths...]
 *
 * Through the daemon's own measurer (the vendored opentype.js faces) AND the
 * constant-ratio one, because the edit path takes the taller of the two
 * readings, and through `naturalNodeContentSize`, the call that path makes.
 *
 * Two shapes per length, since they are priced differently:
 *   paragraph  one paragraph of prose, spaces but no blank line — the shape a
 *              single long line of model output takes
 *   broken     the same prose with a paragraph break every ~560 characters
 *
 * Reported per row: CPU milliseconds, microseconds per character (constant
 * when the cost is linear), the measure calls the layout made, and the
 * longest string one opentype call received — the input whose length a
 * superlinear call is superlinear in.
 */
import {
  constantRatioMeasureText,
  createSpatialTheme,
  naturalNodeContentSize,
} from '@kamiazya/whiteboard-canvas-render'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { createExportTextMeasurer } from '../../src/server/export/measure-text.ts'
import { opentypeApi } from '../../src/shared/opentype.ts'

const LENGTHS = process.argv.slice(2).map(Number)
const lengths = LENGTHS.length > 0 ? LENGTHS : [1024, 2048, 4096, 8192]
const appearance = createSpatialTheme({ mode: 'light' })

const sentence = 'Lorem ipsum dolor sit amet. '
function prose(length, breakEvery) {
  let text = ''
  while (text.length < length) {
    text += sentence.repeat(20)
    if (breakEvery) text += '\n\n'
  }
  return text.slice(0, length)
}

// The longest single string opentype measured, read at the font rather than
// at the seam: the seam's input is what the layout asked, the font's is what
// the measurer chose to hand on in one call.
let longestFontCall = 0
const fontProto = opentypeApi.Font.prototype
const original = fontProto.getAdvanceWidth
fontProto.getAdvanceWidth = function (text, ...rest) {
  if (text.length > longestFontCall) longestFontCall = text.length
  return original.call(this, text, ...rest)
}

const { measure } = await createExportTextMeasurer({ fontsDir: '/nonexistent-fonts-dir' })

function layOut(text) {
  let calls = 0
  const counted = (m) => (t, d) => {
    calls++
    return m(t, d)
  }
  const node = textNode({ id: 'n', text, x: 0, y: 0, width: 200, height: 100 })
  longestFontCall = 0
  const before = process.cpuUsage()
  for (const m of [measure, constantRatioMeasureText]) {
    naturalNodeContentSize(node, { measure: counted(m), appearance })
  }
  const spent = process.cpuUsage(before)
  return { cpuMs: (spent.user + spent.system) / 1000, calls, longest: longestFontCall }
}

// Warm the JIT and the font tables, so the first row is not module load.
layOut(prose(512, false))

console.log('shape      chars    cpu ms   us/char   measure calls  longest font call')
for (const length of lengths) {
  for (const [shape, breaks] of [
    ['paragraph', false],
    ['broken', true],
  ]) {
    const text = prose(length, breaks)
    const { cpuMs, calls, longest } = layOut(text)
    console.log(
      `${shape.padEnd(9)} ${String(length).padStart(6)} ${cpuMs.toFixed(1).padStart(9)} ${((cpuMs * 1000) / length).toFixed(1).padStart(9)} ${String(calls).padStart(15)} ${String(longest).padStart(18)}`,
    )
  }
}
