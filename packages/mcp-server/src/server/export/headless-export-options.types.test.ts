import { expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { exportRequestSchema } from '../../shared/api-contracts/export.js'
import type { exportSvgRequestSchema } from '../../shared/api-contracts/export-svg.js'
import type { HeadlessCanvasExportOptions } from './headless-export.js'

// Compile-time only: HeadlessCanvasExportOptions is a hand-written interface
// that mirrors a subset of exportRequestSchema's/exportSvgRequestSchema's
// fields rather than deriving from them via z.infer, so it can silently
// drift from the wire schema — the exact class of bug zod-schema-discipline
// exists to catch. routes/export.ts forwards padding/scale/frameId/minFontPx/
// theme from exportRequestSchema; routes/canvas/export-svg.ts forwards only
// padding/frameId/theme from exportSvgRequestSchema (no scale/minFontPx —
// vector output has neither raster scale nor a font-bump ceiling).

it('HeadlessCanvasExportOptions matches the PNG route-forwarded exportRequestSchema fields exactly', () => {
  expectTypeOf<HeadlessCanvasExportOptions>().toEqualTypeOf<
    Pick<
      z.infer<typeof exportRequestSchema>,
      'padding' | 'scale' | 'frameId' | 'minFontPx' | 'theme'
    >
  >()
})

it('the SVG-relevant subset of HeadlessCanvasExportOptions matches exportSvgRequestSchema exactly', () => {
  expectTypeOf<Pick<HeadlessCanvasExportOptions, 'padding' | 'frameId' | 'theme'>>().toEqualTypeOf<
    Pick<z.infer<typeof exportSvgRequestSchema>, 'padding' | 'frameId' | 'theme'>
  >()
})
