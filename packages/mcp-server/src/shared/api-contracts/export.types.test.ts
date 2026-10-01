import { expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { ExportResponse, exportResponseSchema } from './export.js'

// Compile-time only: proves ExportResponse is exactly the z.infer of its
// schema, so a future hand-written edit to the type cannot silently drift
// from the schema the route validates against.

it('ExportResponse is exactly z.infer<typeof exportResponseSchema>', () => {
  expectTypeOf<ExportResponse>().toEqualTypeOf<z.infer<typeof exportResponseSchema>>()
})
