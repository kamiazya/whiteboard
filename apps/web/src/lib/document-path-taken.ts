import { DocumentPathTakenError } from '@kamiazya/whiteboard-ports'
import { DaemonApiError } from './daemon-api-client.js'
import { type FolderNames, folderDisplayName } from './folder-names.js'

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The daemon forwards the raised message as a 409's title, so its shape is
// read off the port's own error rather than written out a second time.
const RAISED = (() => {
  const [before = '', after = ''] = new DocumentPathTakenError('\u0001', '\u0000').message.split(
    '\u0000',
  )
  const [middle = '', end = ''] = after.split('\u0001')
  return new RegExp(`^${literal(before)}(.+)${literal(middle)}[^"]*${literal(end)}$`)
})()

/** The path a keeper refused because a document already stands there, or undefined. */
function takenPathOf(err: unknown): string | undefined {
  if (err instanceof DocumentPathTakenError) return err.path
  if (err instanceof DaemonApiError && err.status === 409) return RAISED.exec(err.message)?.[1]
  return undefined
}

/**
 * The taken-address refusal for people: the keeper's own sentence names the
 * workspace by its id, which means nothing on screen. The folder is named as
 * it is called, and the clash by the address inside it.
 */
export function documentPathTakenMessage(err: unknown, names?: FolderNames): string | undefined {
  const path = takenPathOf(err)
  if (path === undefined) return undefined
  const cut = path.lastIndexOf('/')
  const folder = cut === -1 ? '' : path.slice(0, cut)
  return (
    `${folderDisplayName(folder, names)} already has a document at "${path.slice(cut + 1)}". ` +
    'Change one of their addresses, or choose another folder.'
  )
}
