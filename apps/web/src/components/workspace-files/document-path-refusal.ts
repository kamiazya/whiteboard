import { documentPathSchema } from '@kamiazya/whiteboard-model'

/**
 * Why a document form will not ask the keeper for this path, or null when it
 * may. Checked against the model before the request so the refusal is worded
 * beside the field: the keeper refuses the same path, but its refusal is a
 * schema failure written for a log.
 */
export function documentPathRefusal(path: string): string | null {
  const checked = documentPathSchema.safeParse(path)
  return checked.success ? null : (checked.error.issues[0]?.message ?? 'Not a valid path.')
}
