import { z } from 'zod'

// Schema for the element shape that resolveParentedElements reads from Loro storage.
//
// Required fields mirror what resolveParentedElements uses for layout computation.
// Extra Excalidraw fields (type, strokeColor, angle, boundElements, …) pass through
// via .catchall(z.unknown()) so the inferred type stays assignable to ParentedElement's
// open [key: string]: unknown index signature. The catchall is deliberate looseness
// on extra fields only — the required numeric/string fields above it remain strict.
export const loroRawElementSchema = z
  .object({
    id: z.string(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    isDeleted: z.boolean().optional(),
    parentId: z.string().optional(),
    relX: z.number().optional(),
    relY: z.number().optional(),
  })
  .catchall(z.unknown())

export type LoroRawElement = z.infer<typeof loroRawElementSchema>

/**
 * Validate a raw array from Loro storage, dropping rows that fail the schema.
 *
 * Each row is validated independently with safeParse — a single bad row does
 * not abort the whole array (graceful degradation, not total failure).
 * The caller supplies onDropped to handle logging in their own idiom,
 * keeping server-only logger imports out of the browser bundle.
 */
export function validateLoroRawElements(
  raw: unknown[],
  onDropped?: (info: { index: number; error: z.ZodError; raw: unknown }) => void,
): LoroRawElement[] {
  const valid: LoroRawElement[] = []
  for (let i = 0; i < raw.length; i++) {
    const result = loroRawElementSchema.safeParse(raw[i])
    if (result.success) {
      valid.push(result.data)
    } else {
      onDropped?.({ index: i, error: result.error, raw: raw[i] })
    }
  }
  return valid
}
