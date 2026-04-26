import { z } from 'zod'

// Geometry primitive used by frame, library, and template output shapes.
// Co-located here so a future fourth consumer doesn't trigger another round of
// duplication.
export const boundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})
