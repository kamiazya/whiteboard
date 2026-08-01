import { expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type {
  ExportErrorBody,
  ExportResponse,
  exportErrorBodySchema,
  exportResponseSchema,
} from './export.js'

// Compile-time only: proves ExportResponse/ExportErrorBody are exactly the
// z.infer of their schema, so a future hand-written edit to either type
// cannot silently drift from the schema the route validates against.

it('ExportResponse is exactly z.infer<typeof exportResponseSchema>', () => {
  expectTypeOf<ExportResponse>().toEqualTypeOf<z.infer<typeof exportResponseSchema>>()
})

it('ExportErrorBody is exactly z.infer<typeof exportErrorBodySchema>', () => {
  expectTypeOf<ExportErrorBody>().toEqualTypeOf<z.infer<typeof exportErrorBodySchema>>()
})
