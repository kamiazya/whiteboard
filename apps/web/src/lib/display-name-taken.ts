import { DisplayNameTakenError } from '@kamiazya/whiteboard-ports'

/**
 * The sentence a duplicate name is refused with — the keeper's own, built
 * from the same error both keepers throw, so a refusal seen here before
 * sending reads exactly like one a keeper answers after.
 */
export function displayNameTakenMessage(
  kind: 'folder' | 'document',
  path: string,
  name: string,
): string {
  return new DisplayNameTakenError(kind, path, name).message
}
