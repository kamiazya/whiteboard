// What a workspace sync's judge found, as the refusal every surface answers it
// with: text and placement breaches alike, built here and nowhere else.
import {
  isWorkspaceSyncBreach,
  type SyncTextBreach,
  type WorkspaceSyncBreach,
} from '@kamiazya/whiteboard-loro-adapter'
import { TooManyDocumentsError, TooManyFoldersError } from '@kamiazya/whiteboard-ports'
import {
  CausalGapError,
  DocumentKindChangedError,
  DocumentNameTooLongError,
  FolderNameRefusedError,
  OffGrammarPathError,
  type SyncWriteRefusalError,
  textBreachRefusal,
  UnreadableDocumentMetaError,
} from './sync-write-refusals.js'

/** The refusal for what `judgeWorkspaceSyncImport` found. */
export function workspaceSyncRefusal(
  breach: SyncTextBreach | WorkspaceSyncBreach,
): SyncWriteRefusalError {
  if (!isWorkspaceSyncBreach(breach)) return textBreachRefusal(breach)
  switch (breach.shape) {
    case 'causal-gap':
      return new CausalGapError()
    case 'too-many-documents':
      return new TooManyDocumentsError(breach.count)
    case 'too-many-folders':
      return new TooManyFoldersError(breach.count)
    case 'unreadable-document-meta':
      return new UnreadableDocumentMetaError(breach.nodes)
    case 'invalid-path':
      return new OffGrammarPathError(breach.paths)
    case 'document-name-too-long':
      return new DocumentNameTooLongError(breach.paths)
    case 'folder-name-refused':
      return new FolderNameRefusedError(breach.paths, breach.reason)
    case 'document-kind-changed':
      return new DocumentKindChangedError(breach.recorded, breach.kind, breach.documentId)
  }
}
