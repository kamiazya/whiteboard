import { expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { ExportSvgRequest, exportSvgRequestSchema } from './export-svg.js'

// Compile-time only: proves ExportSvgRequest is exactly the z.infer of
// exportSvgRequestSchema, so a future hand-written edit to the type cannot
// silently drift from the schema the export-svg route validates against.

it('ExportSvgRequest is exactly z.infer<typeof exportSvgRequestSchema>', () => {
  expectTypeOf<ExportSvgRequest>().toEqualTypeOf<z.infer<typeof exportSvgRequestSchema>>()
})
