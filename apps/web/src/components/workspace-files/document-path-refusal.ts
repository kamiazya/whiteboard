import { DOCUMENT_PATH_MAX_LENGTH, documentPathSchema } from '@kamiazya/whiteboard-model'

/** The address rule, as the forms state it before anything is typed. */
export const ADDRESS_RULE = 'Letters a–z, digits and hyphens; made from the name.'

/**
 * Why a document form will not ask the keeper for this path, or null when it
 * may. Checked against the model before the request so the refusal is worded
 * beside the field: the keeper refuses the same path, but its refusal is a
 * schema failure written for a log.
 */
export function documentPathRefusal(path: string): string | null {
  if (documentPathSchema.safeParse(path).success) return null
  if (path.length > DOCUMENT_PATH_MAX_LENGTH) {
    return `An address is at most ${DOCUMENT_PATH_MAX_LENGTH} characters.`
  }
  if (path.split('/').some((segment) => segment === '')) {
    return 'Each part between slashes needs at least one letter or digit.'
  }
  return 'An address uses only letters a–z, digits and hyphens, with / between folders, and no hyphen at either end of a part.'
}
