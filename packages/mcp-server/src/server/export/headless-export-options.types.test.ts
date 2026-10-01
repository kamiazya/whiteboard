import { expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { exportRequestSchema } from '../../shared/api-contracts/export.js'
import type { exportSvgRequestSchema } from '../../shared/api-contracts/export-svg.js'
import type { HeadlessCanvasExportOptions } from './headless-export.js'

// Compile-time only: HeadlessCanvasExportOptions is derived via
// Pick<z.infer<typeof exportRequestSchema>, ...> rather than hand-written, so
// it cannot silently drift from the wire schema — the exact class of bug
// zod-schema-discipline exists to catch. This test is the conformance guard:
// it fails to compile (under `pnpm typecheck`, not the runtime test run —
// expectTypeOf assertions are erased at runtime) if the derived type and the
// route-forwarded field set ever diverge. routes/export.ts forwards
// padding/scale/theme/style from exportRequestSchema;
// routes/document/export-svg.ts forwards only padding/theme/style from
// exportSvgRequestSchema (no scale — vector output has no raster scale).

it('HeadlessCanvasExportOptions matches the PNG route-forwarded exportRequestSchema fields exactly', () => {
  expectTypeOf<HeadlessCanvasExportOptions>().toEqualTypeOf<
    Pick<z.infer<typeof exportRequestSchema>, 'padding' | 'scale' | 'theme' | 'style'>
  >()
})

it('the SVG-relevant subset of HeadlessCanvasExportOptions matches exportSvgRequestSchema exactly', () => {
  expectTypeOf<Pick<HeadlessCanvasExportOptions, 'padding' | 'theme' | 'style'>>().toEqualTypeOf<
    Pick<z.infer<typeof exportSvgRequestSchema>, 'padding' | 'theme' | 'style'>
  >()
})
